/**
 * The "never judged" flag.
 *
 * It exists to separate "busy" from "stuck": an active goal the judge has never seen reads
 * "running" forever with nothing advancing it, which is what a deaf event loop looks like.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { neverJudged } from "../src/status-flag.ts"

describe("neverJudged", () => {
  test("true only for an active goal with no turns and no verdict", () => {
    assert.equal(neverJudged("active", 0, undefined), true)
  })

  test("false once a turn has been spent, judged or not", () => {
    assert.equal(neverJudged("active", 1, undefined), false)
  })

  test("false once a verdict exists", () => {
    assert.equal(neverJudged("active", 0, "real progress still possible"), false)
  })

  test("false for every non-active status", () => {
    for (const status of ["paused", "done", "blocked"] as const) {
      assert.equal(neverJudged(status, 0, undefined), false, status)
    }
  })
})
