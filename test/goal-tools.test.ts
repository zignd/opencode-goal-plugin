import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { goalBlocked, goalEvidence, goalPending, heldByTool } from "../src/goal-tools.ts"
import { emptyDigest } from "../src/evidence.ts"
import { pendingBackground } from "../src/waiting.ts"
import { allowanceUsedMessage } from "../src/waiting.ts"
import { OUTPUT_CAP } from "../src/cap.ts"

const active = {
  status: "active" as const,
  goal: "close it",
  evidence: emptyDigest(),
  pausedBy: undefined as "tool" | undefined,
  reason: undefined as string | undefined,
}

const launch = (id: string) => ({
  type: "assistant",
  content: [{ type: "tool", state: { input: { background: true }, output: `started ${id}` } }],
})
const child = (id: string) => ({
  type: "assistant",
  content: [
    {
      type: "tool",
      state: { input: { background: true }, content: [{ type: "text", text: `sessionID: ${id}` }] },
    },
  ],
})
const notice = (id: string, kind: "shell" | "subagent" = "shell") =>
  kind === "shell"
    ? { type: "synthetic", text: `<shell id="${id}" state="completed" command="make">` }
    : { type: "synthetic", text: `<subagent sessionID="${id}" state="completed">` }

describe("goal_blocked", () => {
  test("a reason pauses and does not schedule a continuation", () => {
    const effect = goalBlocked(active, "WebKit is not installed")
    assert.equal(effect.schedule, false)
    assert.equal(effect.state?.status, "paused")
    assert.equal(effect.state?.pausedBy, "tool")
    assert.equal(effect.state?.reason, "WebKit is not installed")
  })

  test("an empty reason is rejected and the goal stays active", () => {
    const effect = goalBlocked(active, "   ")
    assert.equal(effect.state, undefined)
    assert.match(effect.content, /stays active/)
    assert.equal(active.status, "active")
  })

  test("a following continue does not wake a tool pause", () => {
    const paused = goalBlocked(active, "a macOS proof needs a person at the machine").state!
    assert.equal(heldByTool(paused), true)
    assert.equal(paused.status, "paused")
  })

  test("an idle goal no-ops with a sentence", () => {
    const effect = goalBlocked(undefined, "anything")
    assert.match(effect.content, /No goal is active/)
    assert.equal(effect.schedule, false)
  })
})

describe("goal_pending", () => {
  test("matches pendingBackground for a mix of unfinished and finished work, and returns only ids", () => {
    const messages = [
      launch("sh_live"),
      child("ses_live"),
      launch("sh_done"),
      child("ses_done"),
      notice("sh_done"),
      notice("ses_done", "subagent"),
    ]
    const ids = pendingBackground(messages)
    assert.deepEqual(ids, ["sh_live", "ses_live"])
    const effect = goalPending(active, ids)
    assert.equal(effect.content, "sh_live\nses_live")
    assert.doesNotMatch(effect.content, /make|started|command/)
  })
})

describe("goal_wait allowance", () => {
  test("the exhausted message names the pending ids and does not say do other work", () => {
    const text = allowanceUsedMessage(["sh_live", "ses_live"])
    assert.match(text, /sh_live/)
    assert.match(text, /ses_live/)
    assert.doesNotMatch(text, /do other work/)
  })
})

describe("goal_evidence", () => {
  test("two calls accumulate in order, and a third past the cap drops the oldest", () => {
    const first = goalEvidence(active, { command: "one", exit: 0, output: "a" }, 2)
    const second = goalEvidence(first.state, { command: "two", exit: 0, output: "b" }, 2)
    const third = goalEvidence(second.state, { command: "three", exit: 1, output: "c" }, 2)
    assert.deepEqual(
      third.state?.evidence?.entries.map((entry) => entry.command),
      ["two", "three"],
    )
    assert.equal(third.state?.evidence?.dropped, 1)
    assert.equal(third.state?.status, "active")
    assert.equal(third.schedule, false)
  })

  test("a call before the digest exists is a hard error", () => {
    assert.throws(
      () => goalEvidence({ status: "active", goal: "x" }, { command: "grep", exit: 0, output: "ok" }),
      /no digest exists yet/,
    )
  })

  test("an empty command is rejected, and a long output is capped", () => {
    const empty = goalEvidence(active, { command: "  ", exit: 0, output: "x" })
    assert.equal(empty.state, undefined)
    const filed = goalEvidence(active, {
      command: "cat log",
      exit: 0,
      output: "H" + "z".repeat(OUTPUT_CAP * 3) + "T",
    })
    assert.match(filed.state!.evidence!.entries[0].output, /characters omitted/)
    assert.match(filed.state!.evidence!.entries[0].output, /^H/)
    assert.match(filed.state!.evidence!.entries[0].output, /T$/)
  })
})
