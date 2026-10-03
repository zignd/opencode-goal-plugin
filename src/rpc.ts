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

import type { Round } from "./rounds.js"

export type GoalStatus = "active" | "paused" | "done" | "blocked"

/**
 * The command reference, defined here because this is the only module both
 * halves import. It lives in rpc.ts rather than index.ts on purpose: index.ts is
 * the server plugin, and importing it from the TUI would evaluate a whole
 * second plugin in the client process.
 */
export { HELP_SECTIONS, HELP_TEXT } from "./help.js"

export type GoalView = {
  sessionID: string
  goal: string
  status: GoalStatus
  turns: number
  /** null means no turn limit. */
  maxTurns: number | null
  stalled: number
  repeats: number
  /** Turns that re-read an unchanged result. Optional: added after v1 shipped, so it is
   *  deliberately not in `required` and older views simply do not carry it. */
  observing?: number
  /** The judge's most recent one-sentence reason, or "". */
  reason: string
  /** The goal's own proof condition, or "". */
  verification: string
  updatedAt: number
  /** When the running turn's prompt was sent, or 0 when unknown. Optional: older servers omit it. */
  turnStartedAt?: number
  /** Settled turns, newest last. Optional for the same reason. */
  rounds?: Round[]
  roundsDropped?: number
}

const state = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    goal: { type: "string" },
    status: { type: "string", enum: ["active", "paused", "done", "blocked"] },
    turns: { type: "number" },
    maxTurns: { anyOf: [{ type: "number" }, { type: "null" }] },
    stalled: { type: "number" },
    repeats: { type: "number" },
    observing: { type: "number" },
    reason: { type: "string" },
    verification: { type: "string" },
    updatedAt: { type: "number" },
    turnStartedAt: { type: "number" },
    roundsDropped: { type: "number" },
    rounds: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "number" },
          startedAt: { type: "number" },
          endedAt: { type: "number" },
          ms: { type: "number" },
          toolCalls: { type: "number" },
          outcome: { type: "string" },
          reason: { type: "string" },
          achieved: { type: "string" },
          fallback: { type: "boolean" },
        },
        required: ["n", "startedAt", "endedAt", "ms", "toolCalls", "outcome", "reason", "achieved"],
        additionalProperties: false,
      },
    },
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

const settingChoice = {
  type: "object",
  properties: {
    label: { type: "string" },
    argument: { type: "string" },
    current: { type: "boolean" },
  },
  required: ["label", "argument", "current"],
  additionalProperties: false,
} as const

const settingControl = {
  type: "object",
  properties: {
    key: { type: "string", enum: ["budget", "stall", "poll", "quiet", "judge"] },
    label: { type: "string" },
    value: { type: "string" },
    source: { type: "string" },
    hint: { type: "string" },
    editable: { type: "boolean" },
    placeholder: { type: "string" },
    draft: { type: "string" },
    choices: { type: "array", items: settingChoice },
  },
  required: ["key", "label", "value", "source", "hint", "editable", "placeholder", "draft", "choices"],
  additionalProperties: false,
} as const

const settingsFormSchema = {
  type: "object",
  properties: {
    intro: { type: "string" },
    controls: { type: "array", items: settingControl },
    commands: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["intro", "controls", "commands", "notes"],
  additionalProperties: false,
} as const

const settingsPayload = {
  type: "object",
  properties: { text: { type: "string" }, form: settingsFormSchema },
  required: ["text", "form"],
  additionalProperties: false,
} as const

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
    /**
     * The clickable `/goal settings` form. The server owns the values; the TUI
     * only renders this and sends changes back through `configure`.
     */
    readSettings: { input: sessionInput, output: settingsPayload },
    /**
     * Apply one setting the same way the slash command would. `argument` is the
     * text after `/goal <key>`, including `default`.
     */
    configure: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          key: { type: "string", enum: ["budget", "stall", "poll", "quiet", "judge"] },
          argument: { type: "string" },
        },
        required: ["sessionID", "key", "argument"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string" },
          text: { type: "string" },
          form: settingsFormSchema,
        },
        required: ["ok", "title", "message", "text", "form"],
        additionalProperties: false,
      },
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
          /** A picker closes on the first pick, so several can be named at once. */
          placements: { type: "array", items: { type: "string" } },
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
    /** `/goal rounds`. The TUI already holds the rounds in the view, so this only asks it to open the window. */
    rounds: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
    /**
     * A short confirmation or complaint for a subcommand the user just ran.
     * Answering these in the transcript would mean a synthetic message, which is
     * a real prompt and costs a model call, so a TUI shows them as a toast
     * instead. Without a TUI the server falls back to posting the message.
     */
    notice: {
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string", enum: ["success", "warning", "error"] },
        },
        required: ["title", "message"],
        additionalProperties: false,
      },
    },
    /**
     * `/goal settings`. `text` is the transcript fallback. `form` is the clickable
     * view; an older server omits it and the TUI falls back to the text.
     */
    settings: {
      schema: {
        type: "object",
        properties: {
          text: { type: "string" },
          sessionID: { type: "string" },
          form: settingsFormSchema,
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
})
