/**
 * Checks for the session settings. Run with: node settings.test.ts
 *
 * Each of these has a parser that a person types into, and a summary they read
 * back, so both are pinned here.
 */
import {
  DEFAULT_STALL,
  modelLabel,
  NO_OVERRIDES,
  parseCount,
  parseFlag,
  parseModel,
  renderSettings,
  resolve,
  type Overrides,
} from "./settings.ts"
import type { Budget } from "./budget.ts"

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

const options = { maxTurns: 20 as Budget, stall: DEFAULT_STALL, quiet: false, judge: null }

console.log("parseCount — /goal stall …")
check("a number", parseCount("5", "stall"), { kind: "value", value: 5 })
check("one is allowed", parseCount("1", "stall"), { kind: "value", value: 1 })
check("whitespace tolerated", parseCount("  4 ", "stall"), { kind: "value", value: 4 })
check("default clears", parseCount("default", "stall"), { kind: "clear" })
check("reset clears", parseCount("reset", "stall"), { kind: "clear" })
check("none clears", parseCount("none", "stall"), { kind: "clear" })
check("zero is not a count", parseCount("0", "stall"), { kind: "invalid" })
check("a negative is not a count", parseCount("-2", "stall"), { kind: "invalid" })
check("a decimal is not a count", parseCount("2.5", "stall"), { kind: "invalid" })
check("empty is invalid", parseCount("  ", "stall"), { kind: "invalid" })
check("nonsense is invalid", parseCount("lots", "stall"), { kind: "invalid" })

console.log("parseFlag — /goal quiet …")
check("on", parseFlag("on"), { kind: "value", value: true })
check("off", parseFlag("off"), { kind: "value", value: false })
check("yes", parseFlag("yes"), { kind: "value", value: true })
check("false", parseFlag("false"), { kind: "value", value: false })
check("uppercase", parseFlag("ON"), { kind: "value", value: true })
check("default clears", parseFlag("default"), { kind: "clear" })
check("unset clears", parseFlag("unset"), { kind: "clear" })
check("empty is invalid", parseFlag(""), { kind: "invalid" })
check("nonsense is invalid", parseFlag("maybe"), { kind: "invalid" })

console.log("parseModel — /goal judge …")
check("provider and model", parseModel("openrouter/google/gemini-3-flash-preview"), {
  kind: "value",
  value: { providerID: "openrouter", id: "google/gemini-3-flash-preview" },
})
check("a slashed model id survives", parseModel("openrouter/perceptron/perceptron-mk1.5"), {
  kind: "value",
  value: { providerID: "openrouter", id: "perceptron/perceptron-mk1.5" },
})
check("a bare model id", parseModel("anthropic/claude-sonnet-4-5"), {
  kind: "value",
  value: { providerID: "anthropic", id: "claude-sonnet-4-5" },
})
check("with a variant", parseModel("openai/gpt-5#high"), {
  kind: "value",
  value: { providerID: "openai", id: "gpt-5", variant: "high" },
})
check("default clears", parseModel("default"), { kind: "clear" })
check("session clears", parseModel("session"), { kind: "clear" })
check("no provider is invalid", parseModel("gpt-5"), { kind: "invalid" })
check("no model is invalid", parseModel("openai/"), { kind: "invalid" })
check("leading slash is invalid", parseModel("/gpt-5"), { kind: "invalid" })
check("empty is invalid", parseModel(""), { kind: "invalid" })

console.log("resolve — options plus overrides")
check("with nothing set, options win", resolve(options, NO_OVERRIDES), {
  maxTurns: 20,
  stall: 2,
  quiet: false,
  judge: null,
  overridden: { maxTurns: false, stall: false, quiet: false, judge: false },
})
const mixed: Overrides = { maxTurns: null, stall: 5, quiet: true, judge: null }
check("only what is overridden changes", resolve(options, mixed), {
  maxTurns: 20,
  stall: 5,
  quiet: true,
  judge: null,
  overridden: { maxTurns: false, stall: true, quiet: true, judge: false },
})
const all: Overrides = { maxTurns: null, stall: 1, quiet: true, judge: { providerID: "a", id: "b" } }
check("an unlimited override survives as null-valued maxTurns", resolve({ ...options, maxTurns: 20 }, {
  ...all,
  maxTurns: null,
}).overridden.maxTurns, false)
check("a judge override is reported as overridden", resolve(options, { ...NO_OVERRIDES, judge: { providerID: "a", id: "b" } }).overridden.judge, true)

console.log("modelLabel")
check("a model", modelLabel({ providerID: "openai", id: "gpt-5" }), "openai/gpt-5")
check("a model with a variant", modelLabel({ providerID: "openai", id: "gpt-5", variant: "high" }), "openai/gpt-5#high")
check("none means the session's model", modelLabel(null), "the session's model")

console.log("renderSettings")
const rendered = renderSettings(
  resolve({ ...options, maxTurns: null }, { ...NO_OVERRIDES, quiet: true, stall: 4 }),
)
check("shows an unlimited budget", /unlimited/.test(rendered), true)
check("shows the stall override", rendered.includes("Stall limit   4 turns"), true)
check("marks the override as this session", /this session/.test(rendered), true)
check("marks the untouched one as the config default", /config default/.test(rendered), true)
check("shows quiet as on", rendered.includes("Quiet mode    on"), true)
check("lists the setters", /\/goal stall/.test(rendered) && /\/goal judge/.test(rendered), true)
check("mentions the panel is TUI-only", /TUI-only/.test(rendered), true)

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
