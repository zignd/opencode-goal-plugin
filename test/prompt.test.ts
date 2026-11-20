import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { buildJudgePrompt, continuationPrompt, TOOLS } from "../src/prompt.ts"

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

  test("subgoals are carried into every continuation", () => {
    const text = continuationPrompt(
      {
        ...state,
        subgoals: [
          { text: "add a regression test", met: false },
          { text: "keep the API shape", met: true },
        ],
      },
      "not yet",
      false,
    )
    assert.match(text, /Additional criteria the user added mid-goal/)
    assert.match(text, /1\. \[ \] add a regression test/)
    assert.match(text, /2\. \[x\] keep the API shape/)
  })

  test("no subgoals adds no block", () => {
    assert.doesNotMatch(continuationPrompt(state, "not yet", false), /Additional criteria/)
    assert.doesNotMatch(continuationPrompt({ ...state, subgoals: [] }, "not yet", false), /Additional criteria/)
  })
})

describe("buildJudgePrompt", () => {
  const base = {
    goal: "close phase 20",
    contract: "",
    turn: "2",
    maxTurns: "20",
    toolCalls: "4",
    stalled: "0",
    observing: "0",
    previous: "not yet",
    response: "did some work",
    evidence: "no evidence filed",
  }

  test("subgoals become an additional criteria block and a met field", () => {
    const prompt = buildJudgePrompt({
      ...base,
      subgoals: "\n\n<additional criteria>\n1. add a regression test\n</additional criteria>",
    })
    assert.match(prompt, /<additional criteria>/)
    assert.match(prompt, /add a regression test/)
    assert.match(prompt, /"met": \[1, 2\]/)
    assert.match(prompt, /Do not return "done" unless the original objective AND every additional criterion are met/)
  })

  test("without subgoals there is no met field or rule", () => {
    const prompt = buildJudgePrompt({ ...base, subgoals: "" })
    assert.doesNotMatch(prompt, /<additional criteria>/)
    assert.doesNotMatch(prompt, /"met"/)
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
