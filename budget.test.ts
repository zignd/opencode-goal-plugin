/**
 * Checks for the turn budget. Run with: node budget.test.ts
 *
 * The exhaustion test is the one backstop between a runaway loop and a very
 * large bill, so it is pinned here rather than living inline in the event loop.
 */
import {
  budgetLabel,
  DEFAULT_BUDGET,
  formatTurns,
  isExhausted,
  parseBudgetArgument,
  readBudgetOption,
  UNLIMITED_HINT,
  UNLIMITED_CAVEAT,
  type Budget,
} from "./budget.ts"

let failures = 0

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
  }
}

console.log("isExhausted — the gate that stops a runaway")
check("not spent at the start", isExhausted(0, 20), false)
check("not spent one under", isExhausted(19, 20), false)
check("spent exactly at the limit", isExhausted(20, 20), true)
check("spent past the limit", isExhausted(21, 20), true)
check("a limit of 1 is spent after one turn", isExhausted(1, 1), true)
check("unlimited is never spent at zero", isExhausted(0, null), false)
check("unlimited is never spent at 20", isExhausted(20, null), false)
check("unlimited is never spent at 100000", isExhausted(100000, null), false)

console.log("parseBudgetArgument — /goal budget …")
check("unlimited", parseBudgetArgument("unlimited"), { kind: "budget", budget: null })
check("Unlimited with odd casing", parseBudgetArgument("  UNLIMITED "), { kind: "budget", budget: null })
check("infinite", parseBudgetArgument("infinite"), { kind: "budget", budget: null })
check("none", parseBudgetArgument("none"), { kind: "budget", budget: null })
check("inf is a short alias", parseBudgetArgument("inf"), { kind: "budget", budget: null })
check("unlim is a short alias", parseBudgetArgument("unlim"), { kind: "budget", budget: null })
check("the infinity sign is an alias", parseBudgetArgument("\u221e"), { kind: "budget", budget: null })
check("infinity sign with padding", parseBudgetArgument(" \u221e "), { kind: "budget", budget: null })
check("unlim is not read as a count", parseBudgetArgument("unlim").kind, "budget")
check("a count", parseBudgetArgument("40"), { kind: "budget", budget: 40 })
check("default", parseBudgetArgument("default"), { kind: "default" })
check("zero is not a budget", parseBudgetArgument("0"), { kind: "invalid", value: "0" })
check("a negative count is invalid", parseBudgetArgument("-5"), { kind: "invalid", value: "-5" })
check("a decimal is invalid", parseBudgetArgument("2.5"), { kind: "invalid", value: "2.5" })
check("nonsense is invalid", parseBudgetArgument("lots"), { kind: "invalid", value: "lots" })
check("empty is invalid", parseBudgetArgument("   "), { kind: "invalid", value: "" })

console.log("readBudgetOption — the maxTurns plugin option")
check("absent uses the default", readBudgetOption(undefined), { budget: DEFAULT_BUDGET })
check("a number is used as-is", readBudgetOption(40), { budget: 40 })
check("null means unlimited", readBudgetOption(null), { budget: null })
check("the word unlimited means unlimited", readBudgetOption("unlimited"), { budget: null })
check("zero is rejected with a warning", readBudgetOption(0), {
  budget: DEFAULT_BUDGET,
  warning:
    "maxTurns must be a whole number of at least 1, or \"unlimited\"; got 0. Using 20.",
})
check("a negative is rejected with a warning", readBudgetOption(-3).budget, DEFAULT_BUDGET)
check("a decimal is rejected with a warning", readBudgetOption(1.5).budget, DEFAULT_BUDGET)
check("garbage is rejected with a warning", readBudgetOption("lots").budget, DEFAULT_BUDGET)
check("a warning is actually present", typeof readBudgetOption(0).warning, "string")

console.log("display")
check("label for a count", budgetLabel(20), "20")
check("label when unlimited", budgetLabel(null), "unlimited")
check("counter with a count", formatTurns(3, 20), "3/20")
check("counter when unlimited", formatTurns(3, null), "3/∞")
check("counter at zero when unlimited", formatTurns(0, null), "0/∞")

console.log("misc")
check("the caveat names what still stops it", /judge|stall|repeat/i.test(UNLIMITED_CAVEAT), true)
check("the hint advertises a short alias", /\binf\b/.test(UNLIMITED_HINT), true)
check("the caveat mentions no ceiling", /ceiling/i.test(UNLIMITED_CAVEAT), true)

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
