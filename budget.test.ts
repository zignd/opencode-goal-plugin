/**
 * The turn budget.
 *
 * `isExhausted` is the one backstop between a runaway loop and a very large
 * bill, so it is pinned here rather than left inline in the event loop.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  budgetLabel,
  DEFAULT_BUDGET,
  formatTurns,
  isExhausted,
  parseBudgetArgument,
  readBudgetOption,
  UNLIMITED_CAVEAT,
  UNLIMITED_HINT,
} from "./budget.ts"

describe("isExhausted", () => {
  test("is not spent at the start", () => {
    assert.equal(isExhausted(0, 20), false)
  })

  test("is not spent one turn under the limit", () => {
    assert.equal(isExhausted(19, 20), false)
  })

  test("is spent exactly at the limit", () => {
    assert.equal(isExhausted(20, 20), true)
  })

  test("is spent past the limit", () => {
    assert.equal(isExhausted(21, 20), true)
  })

  test("a limit of one is spent after one turn", () => {
    assert.equal(isExhausted(1, 1), true)
  })

  for (const turns of [0, 20, 100_000]) {
    test(`an unlimited budget is never spent after ${turns} turns`, () => {
      assert.equal(isExhausted(turns, null), false)
    })
  }
})

describe("parseBudgetArgument", () => {
  const unlimited = { kind: "budget", budget: null }

  for (const word of ["unlimited", "unlim", "unbounded", "infinite", "inf", "none", "no-limit", "∞"]) {
    test(`reads "${word}" as unlimited`, () => {
      assert.deepEqual(parseBudgetArgument(word), unlimited)
    })
  }

  test("ignores casing and padding", () => {
    assert.deepEqual(parseBudgetArgument("  UNLIMITED "), unlimited)
    assert.deepEqual(parseBudgetArgument(" ∞ "), unlimited)
  })

  test("reads a whole number", () => {
    assert.deepEqual(parseBudgetArgument("40"), { kind: "budget", budget: 40 })
  })

  test("reads default as a clear", () => {
    assert.deepEqual(parseBudgetArgument("default"), { kind: "default" })
  })

  for (const [input, value] of [
    ["0", "0"],
    ["-5", "-5"],
    ["2.5", "2.5"],
    ["lots", "lots"],
    ["   ", ""],
  ]) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      assert.deepEqual(parseBudgetArgument(input), { kind: "invalid", value })
    })
  }
})

describe("readBudgetOption", () => {
  test("falls back to the default when absent", () => {
    assert.deepEqual(readBudgetOption(undefined), { budget: DEFAULT_BUDGET })
  })

  test("uses a number as given", () => {
    assert.deepEqual(readBudgetOption(40), { budget: 40 })
  })

  for (const input of [null, "unlimited", "inf", "none", "∞"]) {
    test(`reads ${JSON.stringify(input)} as unlimited`, () => {
      assert.deepEqual(readBudgetOption(input), { budget: null })
    })
  }

  for (const input of [0, -3, 1.5, "lots"]) {
    test(`rejects ${JSON.stringify(input)} and warns`, () => {
      const result = readBudgetOption(input)
      assert.equal(result.budget, DEFAULT_BUDGET)
      assert.equal(typeof result.warning, "string")
      assert.match(result.warning ?? "", /maxTurns must be a whole number/)
    })
  }
})

describe("display", () => {
  test("labels a finite budget as a count", () => {
    assert.equal(budgetLabel(20), "20")
  })

  test("labels an unlimited budget in words", () => {
    assert.equal(budgetLabel(null), "unlimited")
  })

  test("formats the counter against a limit", () => {
    assert.equal(formatTurns(3, 20), "3/20")
  })

  test("formats the counter against no limit", () => {
    assert.equal(formatTurns(3, null), "3/∞")
    assert.equal(formatTurns(0, null), "0/∞")
  })
})

describe("wording", () => {
  test("the unlimited caveat says what still stops the loop", () => {
    assert.match(UNLIMITED_CAVEAT, /judge/i)
    assert.match(UNLIMITED_CAVEAT, /stall|repetition/i)
  })

  test("the unlimited caveat admits there is no ceiling", () => {
    assert.match(UNLIMITED_CAVEAT, /ceiling/i)
  })

  test("the usage hint advertises the short spelling", () => {
    assert.match(UNLIMITED_HINT, /\binf\b/)
  })
})
