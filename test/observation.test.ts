/**
 * The polling guard.
 *
 * An agent waiting on a five-minute gate produces a turn that uses tools, says something
 * new, and learns nothing. That shape defeats both existing guards: the reply digest
 * moves, so `repeats` never fires, and the tool count is non-zero, so `stalled` never
 * fires. Only the judge sees it — and before this change the judge's answer was to
 * declare the *goal* unachievable, from turn-level evidence.
 *
 * `observationOf` is therefore a pure function worth pinning on its own: it has to ignore
 * the tool inputs (so the same read with a reworded command still counts as the same
 * observation) and it has to fail open on a shape it does not recognise.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { observationOf } from "../src/observation.ts"

describe("observationOf", () => {
  test("is empty for a turn with no tool calls", () => {
    assert.equal(
      observationOf([{ type: "assistant", content: [{ type: "text", text: "thinking about it" }] }]),
      "",
    )
  })

  test("ignores the turn's prose entirely", () => {
    const state = { status: "completed", output: "identical output" }
    const first = observationOf([
      { type: "assistant", content: [{ type: "tool", state }] },
    ])
    const second = observationOf([
      { type: "assistant", content: [{ type: "tool", state }] },
    ])
    assert.equal(first, second)
    assert.notEqual(first, "")
  })

  test("is the same when only the tool input is reworded", () => {
    // This is the shape that slipped through: the agent varies the command it runs to
    // read the same unchanged result.
    const a = observationOf([
      {
        type: "assistant",
        content: [{ type: "tool", input: { command: "tail -5 log" }, state: { output: "same" } }],
      },
    ])
    const b = observationOf([
      {
        type: "assistant",
        content: [{ type: "tool", input: { command: "tail -20 log" }, state: { output: "same" } }],
      },
    ])
    assert.equal(a, b)
  })

  test("differs when the result actually differs", () => {
    const a = observationOf([
      { type: "assistant", content: [{ type: "tool", state: { output: "exit 0" } }] },
    ])
    const b = observationOf([
      { type: "assistant", content: [{ type: "tool", state: { output: "exit 1" } }] },
    ])
    assert.notEqual(a, b)
  })

  test("fails open on a shape it does not recognise", () => {
    // The right way for a heuristic to fail: no observation, so the guard stays quiet
    // rather than pausing a loop on a guess.
    assert.equal(
      observationOf([{ type: "assistant", content: [{ type: "tool", state: null }] }]),
      "",
    )
    assert.equal(observationOf([{ type: "assistant", content: [] }]), "")
    assert.equal(observationOf([]), "")
  })

  test("tolerates a cycle in the message values", () => {
    const cyclic: Record<string, unknown> = { output: "x" }
    cyclic.self = cyclic
    const messages = [{ type: "assistant", content: [{ type: "tool", state: cyclic }] }]
    assert.doesNotThrow(() => observationOf(messages as never))
  })

  test("ignores messages that are not the turn's assistant output", () => {
    assert.equal(observationOf([{ type: "user", content: [{ type: "text", text: "hi" }] }]), "")
  })
})
