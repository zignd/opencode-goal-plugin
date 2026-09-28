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
  },
  events: {
    /** Emitted whenever the server writes goal state. `state` is null once cleared. */
    changed: { schema: nullableState },
  },
})
