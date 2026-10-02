import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { FIELDS } from "../src/contract.ts"
import { DRAFT_USAGE, draftPrompt, readSkillBody, SKILL_DESCRIPTION, SKILL_ID } from "../src/skill.ts"

describe("goal-contract skill", () => {
  test("the description says to load it instead of guessing", () => {
    assert.match(SKILL_DESCRIPTION, /instead of/)
    assert.match(SKILL_DESCRIPTION, /\/goal/)
    assert.equal(SKILL_ID, "goal-contract")
  })

  test("the body names every prefix the parser accepts, so the two cannot drift", () => {
    const body = readSkillBody()
    for (const prefix of Object.keys(FIELDS)) {
      assert.ok(body.includes(`${prefix}:`), `the skill does not mention "${prefix}:"`)
    }
  })

  test("the body keeps the rules that are easy to get wrong", () => {
    const body = readSkillBody()
    assert.match(body, /goal_blocked/)
    assert.match(body, /never re-runs the proof/)
    assert.match(body, /no `goal_done`|There is none/)
  })
})

describe("draftPrompt", () => {
  test("carries the outcome and the contract, and forbids starting the work", () => {
    const text = draftPrompt("  close phase 20  ", "CONTRACT BODY")
    assert.match(text, /close phase 20/)
    assert.match(text, /CONTRACT BODY/)
    assert.match(text, /Do not start the work/)
  })

  test("has a usage line for an empty outcome", () => {
    assert.match(DRAFT_USAGE, /\/draft-goal <what/)
  })
})
