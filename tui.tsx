import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync } from "node:fs"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Goal, type GoalView } from "./rpc.js"

/** Temporary: the TUI's own stdout is not visible to automated checks. */
const trace = (...parts: unknown[]) => {
  try {
    appendFileSync("/tmp/goal-tui-trace.log", parts.map(String).join(" ") + "\n")
  } catch {}
}

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
 * control and bring it back with /goalpanel.
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
        trace("ensurePanel", why, "current=", JSON.stringify(current))
        if (current?.name === PANEL) return
        const opened = context.ui.panel.open(PANEL)
        trace("ensurePanel", why, "open returned", String(opened))
      } catch (error) {
        trace("ensurePanel", why, "THREW", (error as Error).message)
      }
    }

    const announce = (state: GoalView) => {
      trace("announce", state.status, "turns=", state.turns)
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

    const offEvents = rpc.events.on("changed", (event) => {
      trace("changed event from", event.location?.directory ?? "(none)")
      if (!isLocal(event.location?.directory)) {
        trace("  -> filtered out, not our location")
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
    })

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
        return { bar: "█".repeat(filled) + "░".repeat(width - filled), colour: status().colour }
      }
      return (
        <>
          <text fg={status().colour}>● goal {status().label}</text>
          <text fg={palette.base}>{props.view.goal}</text>
          <Show when={props.view.verification}>
            <text fg={palette.muted}>proof: {props.view.verification}</text>
          </Show>
          <Show when={props.view.status === "active"}>
            <text fg={palette.muted}>
              {bar().bar} {props.view.turns}/{props.view.maxTurns} turns
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
            {(view) => {
              trace("Body render for", props.panel.sessionID, view().status)
              return <Body view={view()} width={props.panel.width} />
            }}
          </Show>
        </box>
      )
    }

    const offSlot = context.ui.slot({
      append: "session.panel",
      render: (panel) => {
        trace("slot render", "name=", panel.name, "session=", panel.sessionID, "width=", String(panel.width))
        return (
          <Show when={panel.name === PANEL}>
            <Panel panel={panel} />
          </Show>
        )
      },
    })
    trace("slot registered, disposer type:", typeof offSlot)

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "goal.panel.toggle",
          title: "Toggle goal panel",
          slash: { name: "goalpanel" },
          run: () => {
            const current = context.ui.panel.current()
            trace("toggle command, current=", JSON.stringify(current))
            if (current?.name === PANEL) context.ui.panel.close()
            else ensurePanel("toggle command")
          },
        },
      ],
    }))

    return () => {
      offEvents()
      offSlot()
    }
  },
})
