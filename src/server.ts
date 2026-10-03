import { realpathSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { Goal, HELP_TEXT, type GoalView } from "./rpc.js"
import { observationOf } from "./observation.js"
import { capText } from "./cap.js"
import { formatDuration, roundsReport, withRound, type Round } from "./rounds.js"
import { parseVerdict } from "./verdict.js"
import { presentFor, type PresenceRecord } from "./presence.js"
import { parseGoal, renderContract, type Contract } from "./contract.js"
import { appendEvidence, emptyDigest, renderEvidence, withPending, type EvidenceDigest } from "./evidence.js"
import { goalBlocked, goalEvidence, goalPending, heldByTool } from "./goal-tools.js"
import { buildJudgePrompt, continuationPrompt, TOOLS } from "./prompt.js"
import { DRAFT_USAGE, draftPrompt, readSkillBody, SKILL_DESCRIPTION, SKILL_ID, SKILL_PATH } from "./skill.js"
import {
  clampTimeout,
  confirmDone,
  DEFAULT_VERIFY_TIMEOUT_MS,
  renderVerifyBlock,
  runVerifyCommand,
} from "./verify.js"
import {
  allowanceUsedMessage,
  backoffSeconds,
  countPendingAlive,
  MAX_WAIT_MS,
  nextWaitedMs,
  pendingBackground,
  sessionBusy,
  stillRunningMessage,
  waitForBackground,
} from "./waiting.js"
import {
  budgetLabel,
  formatTurns,
  isExhausted,
  parseBudgetArgument,
  readBudgetOption,
  UNLIMITED_CAVEAT,
  UNLIMITED_HINT,
  type Budget,
} from "./budget.js"
import {
  DEFAULT_POLL,
  DEFAULT_STALL,
  modelLabel,
  NO_OVERRIDES,
  parseCount,
  parseFlag,
  parseModel,
  isSettingKey,
  renderSettings,
  resolve,
  settingsForm,
  type ModelRef,
  type Overrides,
  type SettingKey,
} from "./settings.js"
// Pure, no JSX, so the server can share the parser with the TUI.
import { parseDisplayArgument } from "./display.js"
import { reconnect } from "./listen.js"
import { NEVER_JUDGED_HINT, neverJudged } from "./status-flag.js"

/**
 * Persistent goals, modelled on the Ralph loop.
 *
 * `/goal <text>` sets a standing goal for the current session and starts working
 * on it. After each turn a cheap judge model decides whether the goal is done,
 * still in progress, or unachievable. `continue` feeds a continuation prompt
 * straight back into the same session, so the loop runs without the user having
 * to say "keep going".
 *
 * Three independent backstops keep the loop from running forever:
 *   1. the judge returns `blocked` when a goal cannot be concluded as written or
 *      when the agent is visibly going in circles, which pauses the loop;
 *   2. a turn that ran no tools at all is treated as no progress, and a couple
 *      of those in a row pauses the loop even if the judge keeps saying
 *      "continue"; and
 *   3. a hard turn budget pauses the loop even if nothing objects.
 *
 * Commands:
 *   /goal <text>       set or replace the goal, then start the first turn
 *   /goal status       show the goal, its state, and turns used
 *   /goal pause        stop auto-continuation, keep the goal
 *   /goal resume       resume the loop and reset the turn counter
 *   /goal clear        drop the goal
 *
 * A goal can carry a completion contract, which is what makes the judge
 * accurate. A known field prefix, or a fence whose info string is that prefix,
 * is pulled out of the goal text and shown to the judge as the bar for "done".
 * `verify-cmd` is not a description: after a first-pass `done` the plugin runs
 * it and judges again with the output attached.
 *
 *   /goal Port auth to JWT
 *   verify: pytest tests/auth passes
 *   constraints: keep the /login response shape unchanged
 *   scope: only services/auth and its tests
 *   stop when: a DB schema migration is required
 */

type Verdict = "done" | "continue" | "blocked"
type Status = "active" | "paused" | "done" | "blocked"

type GoalState = {
  goal: string
  contract: Contract
  status: Status
  turns: number
  /** null means no turn limit; the loop then relies on the judge and guards. */
  maxTurns: Budget
  stalled: number
  /** Digest of the previous turn's reply, to spot a loop the judge may miss. */
  lastDigest?: string
  repeats: number
  /** Digest of the previous turn's tool results, to spot polling that changes nothing.
   *  Distinct from `lastDigest`: an agent can vary its prose every turn and still be
   *  reading the same unchanged output, which is how waiting gets mistaken for spinning. */
  lastObservation?: string
  observing: number
  /** Consecutive turns spent waiting on background work, and the time that cost. While
   *  a background command is unfinished the no-progress guards stand down, within a bound. */
  waits?: number
  waitedMs?: number
  reason?: string
  /** Set when `goal_blocked` paused the loop. A later judge verdict must not clear it. */
  pausedBy?: "tool"
  /** When the plugin sent the prompt for the turn now running. Judge time is not in a round. */
  turnStartedAt?: number
  /** One entry per settled turn, newest kept, with how many fell off the front. */
  rounds?: Round[]
  roundsDropped?: number
  /** Last verify-cmd results and the ids still pending. Not cleared when a reply forgets them. */
  evidence?: EvidenceDigest
}

const DEFAULT_STALL_LIMIT = 2

/** Where the goal can be shown. The TUI decides which are on; these are the names. */
const DISPLAYS: readonly string[] = ["panel", "footer", "composer", "sidebar"]

/** Small stable digest, so the repeat check does not store whole replies. */
function digest(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 + code + i, 0x85ebca6b) >>> 0
  }
  return `${h1.toString(36)}.${h2.toString(36)}.${text.length}`
}

/** Collapse whitespace and case so trivial reformatting still counts as a repeat. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

/** Project internal state into the shape the TUI panel renders. */
function toView(state: GoalState): Omit<GoalView, "sessionID"> {
  return {
    goal: state.goal,
    status: state.status,
    turns: state.turns,
    maxTurns: state.maxTurns,
    stalled: state.stalled ?? 0,
    repeats: state.repeats ?? 0,
    observing: state.observing ?? 0,
    reason: state.reason ?? "",
    verification: state.contract.verification || state.contract.verifyCmd?.join("\n") || "",
    updatedAt: Date.now(),
    turnStartedAt: state.turnStartedAt ?? 0,
    rounds: state.rounds ?? [],
    roundsDropped: state.roundsDropped ?? 0,
  }
}


function statusReport(state: GoalState | undefined): string {
  if (!state) return "No active goal. Set one with /goal <what you want accomplished>."
  const icon = state.status === "active" ? "⊙" : state.status === "done" ? "✓" : "⏸"
  const lines = [
    `${icon} Goal (${state.status}) — ${formatTurns(state.turns, state.maxTurns)} turns used`,
    `  ${state.goal}`,
  ]
  const last = state.rounds?.[state.rounds.length - 1]
  if (last) lines.push(`  Last round: #${last.n}, ${formatDuration(last.ms)} — ${last.achieved}`)
  if (state.pausedBy === "tool" && state.reason) lines.push(`  Paused: ${state.reason}`)
  else if (state.reason) lines.push(`  Last judge: ${state.reason}`)
  // "running" is also the word for a goal no judge has ever seen, so name that case.
  if (neverJudged(state.status, state.turns, state.reason)) lines.push(NEVER_JUDGED_HINT)
  return lines.join("\n")
}

/** Pull the final assistant text, the model that produced it, and whether the
 *  turn actually touched anything. A turn with no tool calls made no progress
 *  on a goal that requires work, however confident its prose is. */
async function lastAssistantTurn(
  ctx: any,
  sessionID: string,
): Promise<{ text: string; model?: ModelRef; toolCalls: number; observation: string; pending: string[] }> {
  const messages = (await ctx.session.context({ sessionID })) as readonly any[]

  // A turn is every assistant message after the last user or synthetic input.
  // Tool calls usually land in earlier messages of that turn than the final
  // text, so the whole turn has to be scanned — stopping at the last text
  // message would report "0 tool calls" for a turn that plainly used them.
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const type = messages[i]?.type
    if (type === "user" || type === "synthetic") {
      start = i + 1
      break
    }
  }

  const turn = messages.slice(start)
  let model: ModelRef | undefined
  let toolCalls = 0
  let text = ""
  for (const message of turn) {
    if (message?.type !== "assistant") continue
    model ??= message.model as ModelRef | undefined
    const content = (message.content ?? []) as readonly any[]
    toolCalls += content.filter((part) => part.type === "tool").length
    const said = content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (said) text = said
  }
  return {
    text,
    model,
    toolCalls,
    observation: digest(observationOf(turn)),
    pending: pendingBackground(messages),
  }
}


/** True while some process has the file open. Unknown (no lsof) counts as still running. */
async function holdsOpen(path: string): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process")
    return await new Promise<boolean>((resolve) =>
      execFile("lsof", ["-t", path], (error, stdout) =>
        resolve(error && (error as { code?: unknown }).code === "ENOENT" ? true : stdout.trim().length > 0),
      ),
    )
  } catch {
    return true
  }
}

export default Plugin.define({
  id: "goal",
  async setup(ctx) {
    const {
      budget: configuredBudget,
      warning: budgetWarning,
    } = readBudgetOption(ctx.options.maxTurns)
    if (budgetWarning) console.warn(`[goal] ${budgetWarning}`)
    const configuredStall =
      typeof ctx.options.stallLimit === "number" && ctx.options.stallLimit >= 1
        ? ctx.options.stallLimit
        : DEFAULT_STALL
    // Same shape as the stall limit: a whole number of at least 1, else the default.
    const configuredPoll =
      typeof ctx.options.pollLimit === "number" && ctx.options.pollLimit >= 1
        ? ctx.options.pollLimit
        : DEFAULT_POLL
    const configuredJudge = (ctx.options.judgeModel ?? null) as ModelRef | null
    /**
     * Whether to drop the loop's reporting from the transcript. Off by default:
     * the panel is an addition to the chat, not a replacement for it, and a
     * finished goal leaving no mark in the history is disorienting when you
     * scroll back later. Set `quiet: true` to suppress it while a panel is up.
     *
     * Only ever effective when a panel is actually displaying the state, so
     * turning it on in a headless client cannot hide the loop entirely.
     */
    const configuredQuiet = ctx.options.quiet === true
    const suppressed = async (sessionID: string) =>
      (await settingsFor(sessionID)).quiet && (await isAttached(sessionID))
    const judging = new Set<string>()

    const key = (sessionID: string) => `goal:${sessionID}`

    const read = async (sessionID: string) =>
      (await ctx.storage.get(key(sessionID))) as GoalState | undefined

    /**
     * A per-session turn budget, set by /goal budget and applied to every goal
     * from then on. Absent means "use the plugin option", so a one-off
     * /goal budget never silently rewrites the user's config.
     */
    /**
     * All four settings in one record, so the summary, the setters and the loop
     * itself cannot disagree about what is in force. `settings:<session>` holds
     * `{ maxTurns?, stall?, poll?, quiet?, judge? }` with only the overridden keys
     * present; a key that is `null` means the plugin option applies.
     */
    const settingsKey = (sessionID: string) => `settings:${sessionID}`

    const configured = {
      maxTurns: configuredBudget,
      stall: configuredStall,
      poll: configuredPoll,
      quiet: configuredQuiet,
      judge: configuredJudge,
    }

    /**
     * Stored per key, and only when overridden. The earlier budget-only record
     * is still read, so a budget set before this landed is not lost.
     */
    const readOverrides = async (sessionID: string): Promise<Overrides> => {
      const stored = (await ctx.storage.get(settingsKey(sessionID))) as
        | Record<string, unknown>
        | undefined
      const overrides: Overrides = { ...NO_OVERRIDES }
      if (stored && typeof stored === "object") {
        // A present key means the user set it, so a stored null is an explicit
        // "unlimited", not an absent value. Absent keys stay undefined.
        if ("maxTurns" in stored) overrides.maxTurns = (stored.maxTurns as Budget | null) ?? null
        if (typeof stored.stall === "number") overrides.stall = stored.stall
        if (typeof stored.poll === "number") overrides.poll = stored.poll
        if (typeof stored.quiet === "boolean") overrides.quiet = stored.quiet
        // The judge has no third value the way maxTurns does: not set is
        // exactly "use the session's model", so absent is the only unset form.
        if (typeof stored.judge === "object" && stored.judge !== null) {
          overrides.judge = stored.judge as ModelRef
        }
      }
      if (overrides.maxTurns === undefined) {
        // Migrate the old single-value record if one is lying around.
        const legacy = (await ctx.storage.get(`budget:${sessionID}`)) as { budget?: unknown } | undefined
        if (legacy && typeof legacy === "object" && "budget" in legacy) {
          overrides.maxTurns = (legacy.budget as number | null) ?? null
        }
      }
      return overrides
    }

    const writeOverride = async (
      sessionID: string,
      patch: Partial<
        Record<"maxTurns" | "stall" | "poll" | "quiet" | "judge", Budget | number | boolean | ModelRef | null>
      >,
    ) => {
      const stored = (await ctx.storage.get(settingsKey(sessionID))) as Record<string, unknown> | undefined
      const next: Record<string, unknown> = { ...(stored ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      if (Object.keys(next).length === 0) await ctx.storage.remove(settingsKey(sessionID))
      else await ctx.storage.set(settingsKey(sessionID), next as any)
    }

    /** Options merged with this session's overrides. */
    const settingsFor = async (sessionID: string) => resolve(configured, await readOverrides(sessionID))

    /**
     * Apply a changed setting to a running goal so the loop picks it up now,
     * rather than at the next goal. The budget lives on the goal state; the
     * other three are read per turn, so only maxTurns needs writing back.
     */
    const applyLiveBudget = async (sessionID: string, maxTurns: Budget) => {
      const active = await read(sessionID)
      if (active) await write(sessionID, { ...active, maxTurns })
    }

    const settingsSnapshot = async (sessionID: string) => {
      const effective = await settingsFor(sessionID)
      return { text: renderSettings(effective), form: settingsForm(effective, configured) }
    }

    /**
     * Apply one setting. Shared by the slash commands and the settings window, so a click
     * and `/goal stall 4` write the same record and say the same thing.
     */
    const applySetting = async (
      sessionID: string,
      key: SettingKey,
      argument: string,
    ): Promise<{ ok: boolean; title: string; message: string; variant?: "warning" | "error" }> => {
      if (key === "budget") {
        const parsed = parseBudgetArgument(argument)
        if (parsed.kind === "invalid") {
          return {
            ok: false,
            title: "Turn budget",
            message: `Give me ${UNLIMITED_HINT}, a whole number, or default. For example: /goal budget inf.`,
          }
        }
        const next: Budget = parsed.kind === "default" ? configuredBudget : parsed.budget
        await writeOverride(sessionID, { maxTurns: parsed.kind === "default" ? undefined : next })
        await applyLiveBudget(sessionID, next)
        return {
          ok: true,
          title: "Turn budget",
          message:
            parsed.kind === "default"
              ? `reset to the configured default (${budgetLabel(next)})`
              : next === null
                ? "unlimited — the judge and the stall and repetition guards are the only stops"
                : `${next} for this session`,
          ...(next === null ? { variant: "warning" as const } : {}),
        }
      }
      if (key === "stall" || key === "poll") {
        const parsed = parseCount(argument, key)
        const title = key === "stall" ? "Stall limit" : "Poll limit"
        if (parsed.kind === "invalid") {
          return {
            ok: false,
            title,
            message:
              key === "stall"
                ? "Give me a whole number of turns, or default. For example: /goal stall 4."
                : "Give me a whole number of observations, or default. For example: /goal poll 5.",
          }
        }
        const fallback = key === "stall" ? configuredStall : configuredPoll
        const next = parsed.kind === "clear" ? fallback : parsed.value
        await writeOverride(sessionID, { [key]: parsed.kind === "clear" ? undefined : next })
        return {
          ok: true,
          title,
          message:
            parsed.kind === "clear"
              ? `reset to the configured default (${next})`
              : key === "stall"
                ? `${next} turns with no tools`
                : `${next} turns with an unchanged result`,
        }
      }
      if (key === "quiet") {
        const parsed = parseFlag(argument)
        if (parsed.kind === "invalid") {
          return {
            ok: false,
            title: "Quiet mode",
            message: "Give me on, off, or default. For example: /goal quiet off.",
          }
        }
        const next = parsed.kind === "clear" ? configuredQuiet : parsed.value
        await writeOverride(sessionID, { quiet: parsed.kind === "clear" ? undefined : next })
        return {
          ok: true,
          title: "Quiet mode",
          message:
            parsed.kind === "clear"
              ? `reset to the configured default (${next ? "on" : "off"})`
              : next
                ? "on — the panel replaces the loop's transcript notices"
                : "off — the loop writes its turn notices as well as showing the panel",
        }
      }
      const parsed = parseModel(argument)
      if (parsed.kind === "invalid") {
        return {
          ok: false,
          title: "Judge model",
          message:
            "Give me provider/model, optionally #variant, or default. For example: /goal judge openrouter/google/gemini-3-flash-preview.",
        }
      }
      const next = parsed.kind === "clear" ? configuredJudge : parsed.value
      await writeOverride(sessionID, {
        judge: parsed.kind === "clear" || next === null ? undefined : next,
      })
      return {
        ok: true,
        title: "Judge model",
        message:
          parsed.kind === "clear"
            ? `reset to the configured default (${modelLabel(next)})`
            : modelLabel(next),
      }
    }

    const budgetKey = (sessionID: string) => `settings:${sessionID}`
    /**
     * Stored as `{ budget }` rather than the bare value, because `null` is both
     * "unlimited" and what a missing record reads back as. Storing the bare
     * value meant setting unlimited persisted nothing and silently reverted to
     * the configured default.
     */

    const budgetForSession = async (sessionID: string): Promise<Budget> =>
      (await settingsFor(sessionID)).maxTurns

    /**
     * Whether a TUI is running for this session's directory. Used by the three
     * subcommands that can only be served there, so they all fall back to a
     * transcript reply in the same way.
     */
    const tuiHere = async (sessionID: string): Promise<boolean> => {
      const session = (await ctx.session.get({ sessionID })) as {
        location?: { directory?: string }
      }
      const directory = session?.location?.directory
      return Boolean(directory) && (await isTuiPresent(directory!))
    }

    /**
     * Reply to a subcommand the user just ran.
     *
     * A synthetic session message is a real prompt: it starts an execution and
     * costs a model call, and the agent then dutifully repeats the confirmation
     * back. For a one-line "stall limit is now 5" that is pure waste, so a TUI
     * is asked to raise a toast instead. Only a client with no TUI — desktop,
     * web, `opencode run` — falls back to the transcript, because then it is
     * the only channel there is.
     */
    const announce = async (
      sessionID: string,
      title: string,
      message: string,
      variant?: "success" | "warning" | "error",
      /** Extra prose for the transcript only. A toast disappears, so anything
       *  longer than a line belongs here rather than in `message`. */
      detail?: string,
    ) => {
      if (await tuiHere(sessionID)) {
        try {
          await rpc.events.emit("notice", { title, message, ...(variant ? { variant } : {}) })
          return
        } catch {
          // Fall through to the transcript rather than say nothing.
        }
      }
      await note(sessionID, `${title} — ${message}${detail ? `\n\n${detail}` : ""}`)
    }

    const write = async (sessionID: string, state: GoalState | undefined) => {
      if (state) await ctx.storage.set(key(sessionID), state as any)
      else await ctx.storage.remove(key(sessionID))
      await publish(sessionID)
    }

    /**
     * Push the current state to any TUI watching. The panel is the only place
     * the loop reports itself now, so a failed emit must never stop the loop.
     */
    const publish = async (sessionID: string) => {
      try {
        const state = await read(sessionID)
        await rpc.events.emit("changed", {
          sessionID,
          state: state ? { ...toView(state), sessionID } : null,
        })
      } catch {
        // No subscriber, or the connection went away. The loop carries on.
      }
    }

    // A TUI calls attach on setup and again on every update, which doubles as a
    // heartbeat. If it dies the record ages out and the server quietly returns
    // to sending in-band session messages.
    const ATTACH_TTL = 15 * 60 * 1000
    const isAttached = async (sessionID: string) => {
      const record = (await ctx.storage.get(`attached:${sessionID}`)) as { at?: number } | undefined
      if (typeof record?.at !== "number") return false
      if (Date.now() - record.at > ATTACH_TTL) {
        await ctx.storage.remove(`attached:${sessionID}`)
        return false
      }
      return true
    }

    /**
     * Whether a TUI is running for a directory at all. Separate from
     * `isAttached`, which only means a panel is currently displaying a session.
     * Refreshed by the TUI on a timer, so a TUI that is open but idle still
     * counts as present.
     */
    const PRESENT_TTL = 5 * 60 * 1000
    const isTuiPresent = async (directory: string) => {
      const page = await ctx.storage.scan({ prefix: "present:", limit: 100 })
      const records = page.entries.map((entry) => entry.value as PresenceRecord)
      // Records written before the directory was stored carry only a time. They are matched by
      // the exact key, as before, so an older TUI keeps working until its next heartbeat.
      const exact = (await ctx.storage.get(`present:${directory}`)) as PresenceRecord | undefined
      if (exact) records.push({ at: exact.at, directory })
      if (presentFor(records, directory, Date.now(), PRESENT_TTL, canonical)) return true
      // The next occurrence has to be visible in the log: a miss here is what turns a pure
      // question like /goal help into a transcript message, and therefore a prompt.
      console.warn?.(
        `[goal] no TUI is present for ${directory}; answering in the transcript. Seen: ` +
          (records.map((record) => String(record.directory ?? "?")).join(", ") || "none"),
      )
      return false
    }

    const rpc = await ctx.rpc.register(Goal, {
      get: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const state = await read(sessionID)
        return { sessionID, state: state ? { ...toView(state), sessionID } : null }
      },
      attach: async (input) => {
        const { sessionID } = input as { sessionID: string }
        await ctx.storage.set(`attached:${sessionID}`, { at: Date.now() })
        return {}
      },
      detach: async (input) => {
        const { sessionID } = input as { sessionID: string }
        await ctx.storage.remove(`attached:${sessionID}`)
        return {}
      },
      present: async (input) => {
        const { directory } = input as { directory: string }
        const at = Date.now()
        await ctx.storage.set(`present:${directory}`, { at, directory })
        const real = canonical(directory)
        if (real !== directory) await ctx.storage.set(`present:${real}`, { at, directory: real })
        return {}
      },
      readSettings: async (input) => {
        const { sessionID } = input as { sessionID: string }
        return settingsSnapshot(sessionID)
      },
      configure: async (input) => {
        const { sessionID, key, argument } = input as { sessionID: string; key: string; argument: string }
        if (!isSettingKey(key)) {
          const snapshot = await settingsSnapshot(sessionID)
          return { ok: false, title: "Settings", message: "Unknown setting.", text: snapshot.text, form: snapshot.form }
        }
        const result = await applySetting(sessionID, key, argument)
        const snapshot = await settingsSnapshot(sessionID)
        return { ...result, text: snapshot.text, form: snapshot.form }
      },
    })

    /**
     * A global plugin is instantiated once per location, and every instance sees
     * the whole event stream, so one settled turn reaches each of them. If they
     * all acted, each would judge the turn and queue its own continuation.
     *
     * Exactly one instance owns a session: the one loaded for that session's
     * directory. That is decided locally, with no cross-instance messaging, so
     * it cannot race. The storage claim below only covers events that carry no
     * location at all.
     */
    const instanceID = `${ctx.location.directory}:${Math.random().toString(36).slice(2)}`
    const canonical = (path: string) => {
      const trimmed = path.replace(/\/+$/, "")
      try {
        return realpathSync.native(trimmed)
      } catch {
        return trimmed
      }
    }
    const ownedDirectories = new Set(
      [ctx.location.directory, ctx.location.project?.directory, ctx.location.project?.canonical]
        .map((value) => (value === undefined ? undefined : String(value)))
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map(canonical),
    )
    /** `false` = another instance owns it, `true` = ours, `undefined` = unknown. */
    const ownsEvent = (event: { location?: { directory?: string } }) => {
      const directory = event.location?.directory
      if (!directory) return undefined
      return ownedDirectories.has(canonical(directory))
    }

    const claim = async (eventID: string): Promise<boolean> => {
      const claimKey = `claim:${eventID}`
      if (await ctx.storage.get(claimKey)) return false
      await ctx.storage.set(claimKey, { instanceID, at: Date.now() })
      await new Promise((resolve) => setTimeout(resolve, 60))
      const confirmed = (await ctx.storage.get(claimKey)) as { instanceID?: string } | undefined
      return confirmed?.instanceID === instanceID
    }

    /** Drop claims old enough that their event can no longer be redelivered. */
    const pruneClaims = async () => {
      const cutoff = Date.now() - 60 * 60 * 1000
      let page = await ctx.storage.scan({ prefix: "claim:", limit: 200 })
      while (page.entries.length) {
        for (const entry of page.entries) {
          const value = entry.value as { at?: number } | undefined
          if (typeof value?.at === "number" && value.at < cutoff) {
            await ctx.storage.remove(`claim:${entry.key}`)
          }
        }
        if (!page.next) break
        page = await ctx.storage.scan({ prefix: "claim:", limit: 200, after: page.next })
      }
    }

    /**
     * Report to the user. Note that a synthetic inbox message is a real prompt:
     * it starts an execution and costs a model call. So this is only for
     * terminal states and for subcommands the user typed, never per iteration.
     *
     * `note` is unconditional, and is reserved for input errors the user has to
     * see. `say` covers everything the panel can already show, and goes quiet
     * when a TUI is attached so the loop stops paying for messages nobody needs.
     */
    const note = (sessionID: string, text: string) => ctx.session.synthetic({ sessionID, text })
    const say = async (sessionID: string, text: string) => {
      if (!(await suppressed(sessionID))) await note(sessionID, text)
    }
    const terminal = (sessionID: string, text: string) =>
      say(sessionID, `${text}\n\n(The goal loop has stopped. Do not start new work; reply in one short sentence.)`)

    const resolveJudgeModel = async (sessionID: string): Promise<ModelRef> => {
      const sessionJudge = (await settingsFor(sessionID)).judge
      if (sessionJudge) return sessionJudge
      const { model } = await lastAssistantTurn(ctx, sessionID)
      if (model) return model
      const fallback = await ctx.model.default()
      if (fallback) return fallback as unknown as ModelRef
      throw new Error("no model available to judge with")
    }

    const verifyTimeout = clampTimeout(
      typeof ctx.options.verifyTimeoutMs === "number" ? ctx.options.verifyTimeoutMs : DEFAULT_VERIFY_TIMEOUT_MS,
    )

    const judge = async (sessionID: string, state: GoalState, verify?: string) => {
      const { text, model, toolCalls } = await lastAssistantTurn(ctx, sessionID)
      const chosen = (await settingsFor(sessionID)).judge ?? model ?? (await resolveJudgeModel(sessionID))
      const prompt = buildJudgePrompt({
        goal: state.goal,
        contract: renderContract(state.contract),
        turn: String(state.turns + 1),
        maxTurns: budgetLabel(state.maxTurns),
        toolCalls: String(toolCalls),
        stalled: String(state.stalled ?? 0),
        observing: String(state.observing ?? 0),
        previous: state.reason || "(this is the first turn)",
        response: capText(text) || "(the agent produced no text this turn)",
        evidence: renderEvidence(state.evidence),
        verify,
      })
      const result = await ctx.generate.text({ model: chosen, prompt })
      return parseVerdict(result.text)
    }

    const pendingIds = async (sessionID: string) => {
      const messages = (await ctx.session.context({ sessionID })) as readonly unknown[]
      return { messages, ids: pendingBackground(messages) }
    }

    // Permission prompts stay `ask`. This plugin does not turn an unanswered prompt into `allow`.
    // Tools stay registered when no goal is active: a tool that appears and disappears is worse
    // than a no-op, and the host does not re-advertise one between turns.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOLS.goal_wait.name,
        description: TOOLS.goal_wait.description,
        input: {
          type: "object",
          properties: {
            seconds: { type: "number", description: "Longest to wait, 1 to 3600. Default 600." },
          },
        },
        execute: async (raw: unknown, context) => {
          const input = (raw ?? {}) as { seconds?: number }
          const sessionID = context.sessionID as string
          const state = await read(sessionID)
          if (state?.status !== "active") {
            return { content: "No goal is active, so there is nothing to wait for." }
          }
          const listed = await pendingIds(sessionID)
          const budget = Math.max(0, MAX_WAIT_MS - (state.waitedMs ?? 0)) / 1000
          const seconds = Math.min(Math.max(1, Number(input?.seconds) || 600), 3600, budget)
          if (seconds <= 0) return { content: allowanceUsedMessage(listed.ids) }
          const { end, waitedMs } = await waitForBackground({
            seconds,
            intervalMs: 5000,
            graceMs: 8000,
            signal: context.signal,
            // A shell's completion notice is not visible until the turn ends, so the open
            // output file is the signal. A child session has no such file: a missing path
            // is unknown, not alive, and liveness is a query of that session.
            pending: async () => {
              const { messages } = await pendingIds(sessionID)
              return countPendingAlive(messages, {
                fileOpen: holdsOpen,
                sessionBusy: async (id) => {
                  try {
                    const info = (await ctx.session.get({ sessionID: id })) as {
                      outcome?: string | null
                      time?: { idle?: unknown; updated?: unknown } | null
                    }
                    return sessionBusy(info)
                  } catch {
                    return false
                  }
                },
              })
            },
            active: async () => (await read(sessionID))?.status === "active",
          })
          const current = await read(sessionID)
          if (current) await write(sessionID, { ...current, waitedMs: (current.waitedMs ?? 0) + waitedMs })
          const minutes = Math.round(waitedMs / 6000) / 10
          const still = (await pendingIds(sessionID)).ids
          return {
            content:
              end === "finished"
                ? `Background work finished after ${minutes} min. Continue with its result.`
                : end === "timeout"
                  ? stillRunningMessage(minutes, still)
                  : `Wait ended early (${end}).`,
          }
        },
      })
      editor.add({
        name: TOOLS.goal_blocked.name,
        description: TOOLS.goal_blocked.description,
        input: {
          type: "object",
          properties: {
            reason: { type: "string", description: "Why the goal cannot be completed as written." },
          },
          required: ["reason"],
        },
        execute: async (raw: unknown, context) => {
          const sessionID = context.sessionID as string
          const state = await read(sessionID)
          const effect = goalBlocked(state, (raw as { reason?: unknown } | null)?.reason)
          if (effect.state) await write(sessionID, effect.state)
          return { content: effect.content }
        },
      })
      editor.add({
        name: TOOLS.goal_pending.name,
        description: TOOLS.goal_pending.description,
        input: { type: "object", properties: {} },
        execute: async (_raw: unknown, context) => {
          const sessionID = context.sessionID as string
          const state = await read(sessionID)
          const effect = goalPending(state, (await pendingIds(sessionID)).ids)
          return { content: effect.content }
        },
      })
      editor.add({
        name: TOOLS.goal_evidence.name,
        description: TOOLS.goal_evidence.description,
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command that just ran." },
            exit: { type: "number", description: "Its exit code." },
            output: { type: "string", description: "Its output. Long output is capped." },
          },
          required: ["command", "exit", "output"],
        },
        execute: async (raw: unknown, context) => {
          const sessionID = context.sessionID as string
          const state = await read(sessionID)
          const input = (raw ?? {}) as { command?: unknown; exit?: unknown; output?: unknown }
          const effect = goalEvidence(state, input)
          if (effect.state) await write(sessionID, effect.state)
          return { content: effect.content }
        },
      })
    })

    // A skill is advertised by its description and loaded on demand. A failure to read the
    // file must not stop the plugin: the loop and /draft-goal do not depend on it.
    let contractBody = ""
    try {
      contractBody = readSkillBody()
      await ctx.skill.transform((editor) => {
        editor.add({
          id: SKILL_ID,
          name: "Goal contract",
          description: SKILL_DESCRIPTION,
          autoinvoke: true,
          path: SKILL_PATH,
          content: contractBody,
        } as any)
      })
    } catch (error) {
      console.warn?.("[goal] the goal-contract skill was not registered", error)
    }

    const command = await ctx.command.transform((editor) => {
      editor.add({
        name: "draft-goal",
        description: "Write a /goal for you to paste, without starting the work. Usage: /draft-goal <outcome>",
        execute: async ({ sessionID, prompt, delivery }) => {
          const outcome = prompt.text.replace(/^\s*\/draft-goal\b/i, "").trim()
          if (!outcome) {
            await ctx.session.synthetic({ sessionID, text: DRAFT_USAGE })
            return
          }
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: draftPrompt(outcome, contractBody),
            delivery,
          })
        },
      })
      editor.add({
        name: "goal",
        description:
          "Set a standing goal and keep working until it is done, blocked, stalled, or out of turns. " +
          "Subcommands: status, rounds, pause, resume, clear, panel, display, help",
        execute: async ({ sessionID, prompt, delivery }) => {
          // `prompt.text` may or may not still carry the "/goal" prefix.
          const raw = prompt.text.replace(/^\s*\/goal\b/i, "").trim()
          const [head, ...rest] = raw.split(/\s+/)
          const sub = (head ?? "").toLowerCase()
          const argument = rest.join(" ").trim()

          if (["pause", "resume", "clear", "status", "panel", "help", "budget", "rounds"].includes(sub) && !argument) {
            // A subcommand is a direct question, so it always answers — even when
            // the panel is open and already showing the same thing. Going quiet
            // here reads as the command being broken.
            const state = await read(sessionID)
            if (sub === "panel") {
              // Gated on TUI *presence*, not on attach. Attach is dropped when
              // the panel closes, so gating on it made this command able to
              // close the panel but never reopen it.
              if (await tuiHere(sessionID)) {
                try {
                  await rpc.events.emit("panel", {})
                } catch {}
                return
              }
              await note(
                sessionID,
                "The goal panel is a terminal-UI feature. Use /goal status here, or open this directory in the TUI.",
              )
              return
            }
            if (sub === "status") {
              await note(sessionID, statusReport(state))
              return
            }
            if (sub === "rounds") {
              if (await tuiHere(sessionID)) {
                try {
                  await rpc.events.emit("rounds", { sessionID })
                  return
                } catch {
                  // Fall through to the transcript rather than say nothing.
                }
              }
              await note(sessionID, roundsReport(state?.rounds ?? [], state?.roundsDropped ?? 0))
              return
            }
            if (sub === "budget") {
              // No argument: report. The setter lives outside this branch
              // because it takes one.
              const current = await settingsFor(sessionID)
              await announce(
                sessionID,
                "Turn budget",
                budgetLabel(state?.maxTurns ?? current.maxTurns),
              )
              return
            }
            if (sub === "help") {
              // Inside this block on purpose: every subcommand listed here has
              // to return before the clear fall-through at the bottom, or
              // `/goal help` silently drops the goal on the floor.
              if (!(await tuiHere(sessionID))) {
                await note(sessionID, HELP_TEXT)
                return
              }
              try {
                await rpc.events.emit("help", {})
              } catch {}
              return
            }
            if (sub === "pause") {
              if (!state) {
                await note(sessionID, statusReport(undefined))
                return
              }
              await write(sessionID, { ...state, status: "paused", reason: "paused by the user" })
              await note(
                sessionID,
                `⏸ Goal paused — ${formatTurns(state.turns, state.maxTurns)} turns used.`,
              )
              return
            }
            if (sub === "resume") {
              if (!state) {
                await note(sessionID, statusReport(undefined))
                return
              }
              if (state.status === "active") {
                await note(sessionID, statusReport(state))
                return
              }
              const resumed: GoalState = {
                ...state,
                status: "active",
                turns: 0,
                stalled: 0,
                repeats: 0,
                observing: 0,
                lastDigest: undefined,
                lastObservation: undefined,
                reason: undefined,
                pausedBy: undefined,
                turnStartedAt: Date.now(),
              }
              await write(sessionID, resumed)
              await ctx.session.prompt({
                sessionID,
                text: continuationPrompt(
                  { ...resumed, turns: 1 },
                  "resumed by the user",
                  await suppressed(sessionID),
                  (await pendingIds(sessionID)).ids,
                ),
              })
              return
            }
            await write(sessionID, undefined)
            await note(sessionID, "Goal cleared.")
            return
          }

          // `display` takes an optional argument, so it sits outside the
          // no-argument branch above. Every form of it is handled here: an
          // unrecognised placement must be rejected, never fall through to the
          // goal parser and become a goal reading "display bogus off".
          // `budget` and `display` may both carry an argument, so they live out
          // here rather than in the no-argument branch above. Inside that branch
          // `/goal budget 40` would skip it entirely and the goal parser would
          // set a goal reading "budget 40".
          if (sub === "budget" || sub === "stall" || sub === "poll" || sub === "quiet" || sub === "judge") {
            const result = await applySetting(sessionID, sub, argument)
            await announce(sessionID, result.title, result.message, result.ok ? result.variant : "error")
            return
          }

          if (sub === "settings") {
            const snapshot = await settingsSnapshot(sessionID)
            if (await tuiHere(sessionID)) {
              try {
                await rpc.events.emit("settings", { text: snapshot.text, sessionID, form: snapshot.form })
                return
              } catch {
                // Fall through to the transcript rather than say nothing.
              }
            }
            await note(sessionID, snapshot.text)
            return
          }

          if (sub === "display") {
            if (!(await tuiHere(sessionID))) {
              await note(
                sessionID,
                "Where the goal is shown is a terminal-UI setting. Use /goal status here.",
              )
              return
            }
            const parsed = parseDisplayArgument(argument)
            if (parsed.unknown.length) {
              await note(
                sessionID,
                `Unknown display "${parsed.unknown[0]}". Choose from: ${DISPLAYS.join(", ")}.`,
              )
              return
            }
            try {
              await rpc.events.emit("display", {
                placements: parsed.placements,
                ...(parsed.enabled === undefined ? {} : { enabled: parsed.enabled }),
              })
            } catch {}
            return
          }

          if (!raw) {
            await say(sessionID, statusReport(await read(sessionID)))
            return
          }

          const { goal, contract } = parseGoal(raw)
          if (!goal) {
            await note(sessionID, "That goal had no objective text. Try: /goal <what you want accomplished>")
            return
          }

          const budget = await budgetForSession(sessionID)
          const state: GoalState = {
            goal,
            contract,
            status: "active",
            turns: 0,
            maxTurns: budget,
            stalled: 0,
            repeats: 0,
            observing: 0,
            lastDigest: undefined,
            lastObservation: undefined,
            reason: undefined,
            evidence: emptyDigest(),
            turnStartedAt: Date.now(),
            rounds: [],
            roundsDropped: 0,
          }
          await write(sessionID, state)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text:
              `⊙ [goal set — keep working until this is done, or until it is judged unachievable, ` +
              `judged stalled, or out of turns (max ${budgetLabel(budget)})]\n\n` +
              `Goal: ${goal}${renderContract(contract)}`,
            delivery,
          })
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      // A bare `for await` on the event stream exits for good when the stream ends or throws — most
      // reliably when the server restarts — and the listener then stays registered while judging
      // nothing: the goal reads "running" forever and even a user message no longer pauses it.
      // `reconnect` reopens the subscription with a growing delay, so the body below keeps its own
      // `continue`/`break` and never sees the gap.
      for await (const event of reconnect(
        (signal) => ctx.event.subscribe({ signal }),
        {
          signal: controller.signal,
          onError: (error) => console.error?.("[goal] event stream failed; reconnecting", error),
        },
      )) {
        if (
          event.type !== "session.execution.succeeded" &&
          event.type !== "session.execution.failed" &&
          event.type !== "session.execution.interrupted"
        ) {
          continue
        }
        const sessionID = event.data.sessionID
        if (judging.has(sessionID)) continue
        const state = await read(sessionID)
        if (!state || state.status !== "active") continue
        const owned = ownsEvent(event)
        if (owned === false) continue
        if (owned === undefined) {
          if (!(await claim(event.id))) continue
          void pruneClaims().catch(() => {})
        }

        judging.add(sessionID)
        const settledAt = Date.now()
        try {
          if (event.type === "session.execution.failed") {
            const reason = `the turn failed: ${event.data.error?.message ?? "unknown error"}`
            await write(
              sessionID,
              withRound(
                { ...state, status: "paused" as const, reason },
                { settledAt, outcome: "failed", reason, toolCalls: 0 },
              ),
            )
            await terminal(sessionID, `⏸ Goal paused — ${reason}. Use /goal resume to continue.`)
            continue
          }
          if (event.type === "session.execution.interrupted") {
            const why = `interrupted (${event.data.reason})`
            await write(
              sessionID,
              withRound(
                { ...state, status: "paused" as const, reason: why },
                { settledAt, outcome: "interrupted", reason: why, toolCalls: 0 },
              ),
            )
            await terminal(sessionID, `⏸ Goal paused — interrupted (${event.data.reason}). Use /goal resume to continue.`)
            continue
          }

          const preview = await lastAssistantTurn(ctx, sessionID)
          let evidence = withPending(state.evidence ?? emptyDigest(), preview.pending)
          let verdict: { verdict: Verdict; reason: string; achieved?: string }
          try {
            verdict = await judge(sessionID, { ...state, evidence })
          } catch (error) {
            // Fail open: a broken judge must not wedge the loop. The turn budget
            // is the real backstop.
            verdict = { verdict: "continue", reason: `judge unavailable (${(error as Error).message})` }
          }

          // Commands run only after a first-pass done. A continue or blocked does not run them,
          // and the second pass may demote done but must not promote a continue.
          if (verdict.verdict === "done" && (state.contract.verifyCmd?.length ?? 0) > 0) {
            try {
              const session = (await ctx.session.get({ sessionID })) as { location?: { directory?: string } }
              const cwd = session?.location?.directory
              const confirmed = await confirmDone({
                first: verdict,
                commands: state.contract.verifyCmd!,
                run: async (command) => {
                  if (!cwd) {
                    return {
                      command,
                      exit: null,
                      output: "no session directory; command not run",
                      timedOut: false,
                    }
                  }
                  return runVerifyCommand(command, { cwd, env: process.env, timeoutMs: verifyTimeout })
                },
                judgeAgain: async ({ results }) => {
                  const withResults = results.reduce((digest, result) => appendEvidence(digest, result), evidence)
                  try {
                    return await judge(
                      sessionID,
                      { ...state, evidence: withResults },
                      renderVerifyBlock("done", results),
                    )
                  } catch (error) {
                    return {
                      verdict: "continue" as const,
                      reason: `verify-cmd judge unavailable (${(error as Error).message})`,
                    }
                  }
                },
              })
              evidence = confirmed.results.reduce((digest, result) => appendEvidence(digest, result), evidence)
              verdict = { verdict: confirmed.verdict, reason: confirmed.reason, achieved: verdict.achieved }
            } catch (error) {
              verdict = { verdict: "continue", reason: `verify-cmd unavailable (${(error as Error).message})` }
            }
          }

          // A goal_blocked call during this turn already paused. Do not let the verdict overwrite it.
          const fresh = await read(sessionID)
          if (!fresh) continue
          if (heldByTool(fresh)) {
            await write(
              sessionID,
              withRound(fresh, {
                settledAt,
                outcome: "paused",
                reason: fresh.reason,
                achieved: verdict.achieved,
                toolCalls: preview.toolCalls,
              }),
            )
            continue
          }

          const progressed: GoalState = withRound(
            { ...fresh, evidence, reason: verdict.reason },
            {
              settledAt,
              outcome: verdict.verdict,
              reason: verdict.reason,
              achieved: verdict.achieved,
              toolCalls: preview.toolCalls,
            },
          )

          if (verdict.verdict === "done") {
            await write(sessionID, { ...progressed, status: "done" })
            return terminal(sessionID, `✓ Goal achieved: ${verdict.reason || fresh.goal}`)
          }
          if (verdict.verdict === "blocked") {
            await write(sessionID, { ...progressed, status: "blocked" })
            return terminal(
              sessionID,
              `🚫 Goal judged unachievable — paused: ${verdict.reason}\nRe-scope it with /goal <new text>, or /goal resume to override.`,
            )
          }

          // Two deterministic no-progress checks. These, not the judge, are what
          // actually stop a runaway: a weak judge model will happily answer
          // "continue" to twenty identical replies.
          const { toolCalls, text: replyText, observation, pending } = await lastAssistantTurn(ctx, sessionID)
          const reply = normalize(replyText)
          // A background command still running makes a quiet turn legitimate: there is
          // nothing to do but wait. The guards stand down for it, bounded by MAX_WAIT_MS so
          // a hung job cannot hold the loop open forever.
          evidence = withPending(evidence, pending)
          const waiting = pending.length > 0 && (fresh.waitedMs ?? 0) < MAX_WAIT_MS
          const waitSeconds = waiting ? backoffSeconds(fresh.waits ?? 0) : 0
          const repeated = !waiting && reply.length > 0 && fresh.lastDigest === digest(reply)
          const repeats = repeated ? (fresh.repeats ?? 0) + 1 : 0
          const stalled = waiting ? 0 : toolCalls === 0 ? (fresh.stalled ?? 0) + 1 : 0
          // The third no-progress shape: the agent used tools and said something new each
          // turn, but read back the same unchanged result — polling. Neither guard above can
          // see it, because the reply digest moves and the tool count is non-zero. It is
          // counted separately and, on the first turn, only *reported* to the judge, so the
          // agent is told to stop polling before anything is stopped for it.
          const sameObservation =
            observation.length > 0 && fresh.lastObservation === observation
          const observing = !waiting && sameObservation ? (fresh.observing ?? 0) + 1 : 0
          const looping: GoalState = {
            ...progressed,
            evidence,
            lastDigest: reply.length ? digest(reply) : fresh.lastDigest,
            lastObservation: observation.length ? observation : fresh.lastObservation,
            repeats,
            stalled,
            observing,
            waits: waiting ? (fresh.waits ?? 0) + 1 : 0,
            waitedMs: nextWaitedMs(fresh.waitedMs ?? 0, waiting, waitSeconds),
          }

          if (repeats >= 2) {
            await write(sessionID, { ...looping, status: "paused" })
            return terminal(
              sessionID,
              `⏸ Goal paused — looping: the agent has now repeated the same reply ${repeats} turns running without acting. Judge said: ${verdict.reason}\nThis loop is not making progress. Either resume with /goal resume, or re-scope it with /goal <new text>.`,
            )
          }
          if (observing >= (await settingsFor(sessionID)).poll) {
            await write(sessionID, { ...looping, status: "paused" })
            return terminal(
              sessionID,
              `⏸ Goal paused — polling: ${observing} turns ran tools and read back the same unchanged result, so the work is not moving.\nIf a command is still running, wait for its completion instead of re-reading it; otherwise do different work, then /goal resume. This says nothing about whether the goal is reachable.`,
            )
          }
          if (stalled >= (await settingsFor(sessionID)).stall) {
            await write(sessionID, { ...looping, status: "paused" })
            return terminal(
              sessionID,
              `⏸ Goal paused — stalled: ${stalled} turns ran no tools, so nothing changed. Judge said: ${verdict.reason}\nUnblock the cause (missing permission, unavailable tool, wrong directory), then /goal resume.`,
            )
          }

          // The budget gate. An unlimited budget is never spent, which is what
          // leaves the judge and the stall/repetition guards as the only stops.
          if (isExhausted(fresh.turns, fresh.maxTurns)) {
            await write(sessionID, { ...progressed, status: "paused", stalled })
            return terminal(
              sessionID,
              `⏸ Goal paused — ${formatTurns(fresh.maxTurns ?? 0, fresh.maxTurns)} turns used. Use /goal resume for another ${fresh.maxTurns}, or /goal clear to stop.`,
            )
          }

          const next: GoalState = { ...looping, turns: fresh.turns + 1 }
          await write(sessionID, next)
          if (waitSeconds > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000))
            // Someone may have paused, cleared or replaced the goal while we waited.
            if ((await read(sessionID))?.status !== "active") continue
          }
          const sending = await read(sessionID)
          if (sending?.status === "active") await write(sessionID, { ...sending, turnStartedAt: Date.now() })
          // No status message here on purpose: a synthetic inbox message is a
          // real prompt, so it would start another execution, re-enter this
          // loop, and burn the budget twice as fast. The continuation prompt
          // itself already carries the judge's reason.
          await ctx.session.prompt({
            sessionID,
            text: continuationPrompt(next, verdict.reason, await suppressed(sessionID), pending),
          })
        } catch (error) {
          const current = await read(sessionID)
          if (current?.status === "active") {
            await write(sessionID, { ...current, status: "paused", reason: (error as Error).message })
            await terminal(sessionID, `⏸ Goal paused — loop error: ${(error as Error).message}`)
          }
        } finally {
          judging.delete(sessionID)
        }
      }
    })()

    return async () => {
      controller.abort()
      await command.dispose()
    }
  },
})
