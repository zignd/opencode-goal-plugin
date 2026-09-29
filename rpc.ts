import { Rpc } from "@opencode/plugin/rpc"

/**
 * The bridge between the two halves of this plugin.
 *
 * The goal loop runs on the server, where it owns the state. The panel runs in
 * the TUI process, which cannot read server plugin storage directly. This
 * contract is how the TUI learns what the loop is doing: it calls `get` for the
 * session it is showing, subscribes to `changed` for live updates, and calls
 * `attach` so the server knows a TUI is present and can skip the in-band
 * session messages it would otherwise have to send.
 *
 * Every field is always present, with empty strings standing in for absent
 * values, so the payload validates the same way whichever way it was built.
 */

export type GoalStatus = "active" | "paused" | "done" | "blocked"

/**
 * The command reference, defined here because this is the only module both
 * halves import. It lives in rpc.ts rather than index.ts on purpose: index.ts is
 * the server plugin, and importing it from the TUI would evaluate a whole
 * second plugin in the client process.
 */
export const HELP_TEXT = `/goal <text>          set the goal and start working
/goal status          report the goal, its state, turns used, last judge reason
/goal pause           stop auto-continuation, keep the goal
/goal resume          resume with a fresh turn budget
/goal clear           drop the goal
/goal panel           open or close the panel        (TUI)
/goal display         where the goal is shown        (TUI)
/goal help            this message

Completion contract — lines the judge uses to decide "done":
  verify: / verified by:    the command or artifact that proves it
  constraints: / preserve:  what must not change
  scope: / boundaries:      what is in scope
  outcome:                  the end state that must be true
  stop when:                when to stop and ask you

The loop stops on: done, judged unachievable, stalled, repeated, or out of turns.`

export type GoalView = {
  sessionID: string
  goal: string
  status: GoalStatus
  turns: number
  maxTurns: number
  stalled: number
  repeats: number
  /** The judge's most recent one-sentence reason, or "". */
  reason: string
  /** The goal's own proof condition, or "". */
  verification: string
  updatedAt: number
}

const state = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    goal: { type: "string" },
    status: { type: "string", enum: ["active", "paused", "done", "blocked"] },
    turns: { type: "number" },
    maxTurns: { type: "number" },
    stalled: { type: "number" },
    repeats: { type: "number" },
    reason: { type: "string" },
    verification: { type: "string" },
    updatedAt: { type: "number" },
  },
  required: [
    "sessionID",
    "goal",
    "status",
    "turns",
    "maxTurns",
    "stalled",
    "repeats",
    "reason",
    "verification",
    "updatedAt",
  ],
  additionalProperties: false,
} as const

const nullableState = {
  type: "object",
  properties: { sessionID: { type: "string" }, state: { anyOf: [state, { type: "null" }] } },
  required: ["sessionID", "state"],
  additionalProperties: false,
} as const

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const empty = { type: "object", properties: {}, additionalProperties: false } as const

export const Goal = Rpc.define({
  id: "goal",
  methods: {
    /** Current state for a session, or `null` when it has no goal. */
    get: { input: sessionInput, output: nullableState },
    /**
     * Tell the server a TUI is watching this session, so terminal notices can
     * be delivered as a toast instead of a session message. Called on setup and
     * again on every update, which doubles as a heartbeat: if the TUI dies the
     * record goes stale and the server falls back to in-band messages.
     */
    attach: { input: sessionInput, output: empty },
    /**
     * The panel went away, so stop treating this session as TUI-watched. Without
     * this the server would stay quiet until the heartbeat expired, which is a
     * long time to show nothing after deliberately closing the panel.
     */
    detach: { input: sessionInput, output: empty },
    /**
     * Announce that a TUI is running for a directory, refreshed on a timer.
     *
     * This is deliberately not the same thing as `attach`. Attach means "a panel
     * is displaying this session right now", so it is dropped when the panel
     * closes - which is exactly when `/goal panel` most needs to know a TUI is
     * there in order to reopen it.
     */
    present: {
      input: {
        type: "object",
        properties: { directory: { type: "string" } },
        required: ["directory"],
        additionalProperties: false,
      },
      output: empty,
    },
  },
  events: {
    /** Emitted whenever the server writes goal state. `state` is null once cleared. */
    changed: { schema: nullableState },
    /**
     * `/goal panel` arrives on the server, but only the TUI can open a panel, so
     * the request is bounced across. Empty data: the host owns which panel is
     * selected and whether one is already showing.
     */
    panel: { schema: empty },
    /**
     * `/goal display [placement] [on|off]`. Placement and enabled are both
     * optional: omitting the placement means "tell me", which the TUI answers
     * with a dialog. The TUI owns these settings, so it is the one that applies
     * them and persists the result.
     */
    display: {
      schema: {
        type: "object",
        properties: {
          placement: { type: "string" },
          enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    /**
     * `/goal help`. The subcommand list is far too long for a command
     * description and belongs in a dialog the user can read and dismiss, not in
     * the transcript where it would cost a model call.
     */
    help: { schema: empty },
  },
})
