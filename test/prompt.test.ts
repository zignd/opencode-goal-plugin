import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { continuationPrompt, TOOLS } from "../src/prompt.ts"

const state = {
  goal: "close phase 20",
  contract: { verification: "the log is green" },
  turns: 2,
  maxTurns: 20,
}

describe("continuationPrompt", () => {
  test("pending ids produce the do-not-start-another sentence, and name goal_wait", () => {
    const text = continuationPrompt(state, "not yet", false, ["sh_one", "ses_two"])
    assert.match(text, /do not start another/)
    assert.match(text, /sh_one, ses_two/)
    assert.match(text, /goal_wait/)
    assert.doesNotMatch(text, /goal_blocked/)
    assert.doesNotMatch(text, /Take the next concrete step/)
  })

  test("an empty pending list does not say do not start another", () => {
    const text = continuationPrompt(state, "not yet", false, [])
    assert.doesNotMatch(text, /do not start another/)
    assert.match(text, /Take the next concrete step/)
  })

  test("a turn the judge called unfinished names goal_blocked, and points the blocker at the tool", () => {
    const text = continuationPrompt(state, "the proof is not in the reply", false)
    assert.match(text, /goal_blocked/)
    assert.match(text, /goal_evidence/)
    assert.doesNotMatch(text, /name the blocker — that pauses the loop/)
  })
})

describe("tool descriptions", () => {
  test("each description says when to call it instead of replying", () => {
    for (const tool of Object.values(TOOLS)) {
      assert.match(tool.description, /instead of/, tool.name)
    }
    assert.equal("goal_done" in TOOLS, false)
  })
})
