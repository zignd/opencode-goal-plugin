import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Goal, type GoalView } from "./rpc.js"

/**
 * The TUI half of the goal plugin.
 *
 * The loop itself lives on the server. This file only presents it: a panel in
 * the session's right-hand side showing what the goal is and how far the loop
 * has got, and a toast when the loop reaches a terminal state. Because the
 * panel already carries that information, the server suppresses the in-band
 * session messages it would otherwise send, so reporting on a goal costs no
 * extra model calls.
 *
 * The panel opens itself when a goal starts. Dismiss it with the panel's own
 * control, or toggle it with /goal panel.
 */

const PANEL = "goal"

type Changed = { sessionID: string; state: GoalView | null }
type GetResult = { sessionID: string; state: GoalView | null }

/**
 * The RPC schemas are JSON Schema, so both sides see the payloads as unknown.
 * The server validates before emitting, which is the boundary these two casts
 * mark; everything past this point is typed.
 */
const asChanged = (data: unknown) => data as Changed
const asGet = (data: unknown) => data as GetResult

export default Plugin.define({
  id: "goal.tui",
  setup(context) {
    const rpc = context.client.rpc(Goal)
    const [states, setStates] = createSignal<Record<string, GoalView>>({})
    /** Last terminal state toasted per session, so a repaint cannot repeat it. */
    const announced = new Map<string, string>()

    // Prefer theme tokens, but never depend on a token existing: an unknown
    // colour would silently drop the text.
    const token = (name: string, fallback: string) => {
      const text = (context.theme as { text?: Record<string, string> }).text
      return text?.[name] || fallback
    }
    const palette = {
      base: token("base", "#e5e5e5"),
      muted: token("muted", "#8a8a8a"),
      success: token("success", "#4ade80"),
      warning: token("warning", "#fbbf24"),
      error: token("error", "#f87171"),
    }

    const track = (sessionID: string, state: GoalView | null) => {
      setStates((previous) => {
        const next = { ...previous }
        if (state) next[sessionID] = state
        else delete next[sessionID]
        return next
      })
    }

    /**
     * Tell the server this session is TUI-watched. Doubles as a heartbeat: the
     * record expires on its own, so a TUI that dies mid-goal stops suppressing
     * the server's in-band notices rather than silencing them for good.
     *
     * Deliberately scoped to the session this panel is actually showing. The
     * event stream is global, so attaching to everything would silence the
     * in-band notices for headless runs in unrelated projects.
     */
    /**
     * Tell the server a TUI is running for this directory, so `/goal panel`
     * knows it has somewhere to send the request. Kept separate from attach,
     * which is dropped when the panel closes - and a closed panel is precisely
     * when the user reaches for the command to reopen it.
     */
    const markPresent = async () => {
      const directory = context.location?.directory
      if (!directory) return
      try {
        await rpc.present({ directory })
      } catch {
        // Server not ready, or shutting down.
      }
    }

    void markPresent()
    const presenceTimer = setInterval(() => void markPresent(), 60_000)

    const attach = async (sessionID: string) => {
      try {
        await rpc.attach({ sessionID })
      } catch {
        // Server not ready, or shutting down. Harmless.
      }
    }

    /** Panel gone: let the server resume in-band notices straight away. */
    const detach = async (sessionID: string) => {
      try {
        await rpc.detach({ sessionID })
      } catch {
        // Nothing to undo.
      }
    }

    /**
     * Make sure the panel is on screen. Called for every state change rather
     * than only on turn 0, so whichever event lands first still opens it.
     * Wrapped because this runs inside an event callback rather than a command,
     * and a throw here would otherwise be swallowed and leave no panel at all.
     */
    const ensurePanel = (why: string) => {
      try {
        const current = context.ui.panel.current()
        if (current?.name === PANEL) return
        const opened = context.ui.panel.open(PANEL)
      } catch (error) {
      }
    }

    const announce = (state: GoalView) => {
      if (state.status === "active") {
        if (state.turns === 0) ensurePanel("goal started")
        return
      }
      const fingerprint = `${state.status}:${state.turns}:${state.reason}`
      if (announced.get(state.sessionID) === fingerprint) return
      announced.set(state.sessionID, fingerprint)
      context.ui.toast.show({
        title:
          state.status === "done"
            ? "Goal achieved"
            : state.status === "blocked"
              ? "Goal judged unachievable"
              : "Goal paused",
        message: state.reason || state.goal,
        variant: state.status === "done" ? "success" : "warning",
        duration: 8000,
      })
    }

    /** Events arrive for every location, so ignore other projects entirely. */
    const isLocal = (directory: string | undefined) => {
      const mine = context.location?.directory
      if (!directory || !mine) return true
      const trim = (value: string) => value.replace(/\/+$/, "")
      return trim(directory) === trim(mine)
    }

    // Each registration is guarded on its own. A throw anywhere in setup
    // discards the entire plugin, so one bad call would otherwise cost the
    // panel, the toasts and the live updates together.
    const cleanups: Array<() => void> = []
    const guard = (what: string, register: () => (() => void) | void) => {
      try {
        const dispose = register()
        if (typeof dispose === "function") cleanups.push(dispose)
      } catch (error) {
      }
    }

    guard("rpc events", () =>
      rpc.events.on("changed", (event) => {
        if (!isLocal(event.location?.directory)) {
          return
        }
        const { sessionID, state } = asChanged(event.data)
        if (!state) {
          announced.delete(sessionID)
          track(sessionID, null)
          return
        }
        track(sessionID, state)
        announce(state)
      }),
    )

    guard("session.panel slot", () =>
      context.ui.slot({
        append: "session.panel",
        render: (panel) => {
          return (
            <Show when={panel.name === PANEL}>
              <Panel panel={panel} />
            </Show>
          )
        },
      }),
    )

    /** Pull state for a session the panel opened before any event arrived. */
    const prime = async (sessionID: string) => {
      try {
        const result = asGet(await rpc.get({ sessionID }))
        if (result.state) {
          track(sessionID, result.state)
          announced.set(
            sessionID,
            `${result.state.status}:${result.state.turns}:${result.state.reason}`,
          )
          void attach(sessionID)
        }
      } catch {
        // Nothing to show yet.
      }
    }

    const Body = (props: { view: GoalView; width?: number }) => {
      const status = () => {
        switch (props.view.status) {
          case "active":
            return { label: "running", colour: palette.success }
          case "done":
            return { label: "achieved", colour: palette.success }
          case "blocked":
            return { label: "unachievable", colour: palette.error }
          default:
            return { label: "paused", colour: palette.warning }
        }
      }
      const bar = () => {
        const width = Math.max(8, Math.min(28, (props.width ?? 44) - 16))
        const ratio = props.view.maxTurns > 0 ? props.view.turns / props.view.maxTurns : 0
        const filled = Math.min(width, Math.round(ratio * width))
        return "█".repeat(filled) + "░".repeat(width - filled)
      }
      // `turns` counts continuations, so the opening turn is not in it. Adding
      // one keeps "0 turns" from reading as "nothing happened" on a goal that
      // succeeded immediately.
      const turnsUsed = props.view.turns + 1
      return (
        <>
          <text fg={status().colour}>● goal {status().label}</text>
          <text fg={palette.base}>{props.view.goal}</text>
          <Show when={props.view.verification}>
            <text fg={palette.muted}>proof: {props.view.verification}</text>
          </Show>
          <Show
            when={props.view.status === "active"}
            fallback={
              <text fg={palette.muted}>
                finished after {turnsUsed} of {props.view.maxTurns} turns
              </text>
            }
          >
            <text fg={palette.muted}>
              {bar()} turn {props.view.turns}/{props.view.maxTurns}
            </text>
          </Show>
          <Show when={props.view.stalled > 0}>
            <text fg={palette.warning}>stalled: {props.view.stalled} turns with no tools</text>
          </Show>
          <Show when={props.view.repeats > 0}>
            <text fg={palette.warning}>repeating: {props.view.repeats} identical replies</text>
          </Show>
          <Show when={props.view.reason}>
            <text fg={palette.muted}>{props.view.reason}</text>
          </Show>
        </>
      )
    }

    const Panel = (props: { panel: { sessionID: string; width?: number } }) => {
      // A goal that finished before this TUI started would never emit an event,
      // so ask for it once whenever the panel settles on a session. This only
      // runs while the panel is actually mounted, which is what makes attach a
      // truthful signal that something is displaying the state.
      createEffect(() => {
        const sessionID = props.panel.sessionID
        if (sessionID) void prime(sessionID)
      })
      // Unmounting means the user closed the panel; hand the reporting back.
      onCleanup(() => {
        const sessionID = props.panel.sessionID
        if (sessionID) void detach(sessionID)
      })
      return (
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          <Show
            when={states()[props.panel.sessionID]}
            fallback={<text fg={palette.muted}>No goal set. Use /goal to start one.</text>}
          >
            {(view) => <Body view={view()} width={props.panel.width} />}
          </Show>
        </box>
      )
    }

    guard("panel request", () =>
      rpc.events.on("panel", (event) => {
        if (!isLocal(event.location?.directory)) return
        try {
          if (context.ui.panel.current()?.name === PANEL) context.ui.panel.close()
          else ensurePanel("/goal panel")
        } catch {
          // Nothing sensible to do from a toggle.
        }
      }),
    )

    return () => {
      clearInterval(presenceTimer)
      for (const dispose of cleanups.reverse()) {
        try {
          dispose()
        } catch {}
      }
    }
  },
})
