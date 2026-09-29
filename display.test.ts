/**
 * Checks for the display picker. Run with: node display.test.ts
 *
 * The picker had a bug that only a person clicking through the dialog could
 * find, which is exactly the class of bug these exist to catch.
 */
import {
  applyChoice,
  applySet,
  DEFAULTS,
  describe,
  isPlacement,
  seedDisplay,
  type Display,
} from "./display.ts"

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

console.log("seedDisplay")
check("defaults with no options", seedDisplay(undefined), DEFAULTS)
check("panel only off", seedDisplay({ panel: false }), { panel: false, footer: true, composer: false, sidebar: false })
check("unknown keys ignored", seedDisplay({ nope: true, sidebar: true }), { panel: true, footer: true, composer: false, sidebar: true })
check("non-boolean ignored", seedDisplay({ panel: "yes" }), DEFAULTS)

console.log("applyChoice — the reported bug")
const both: Display = { panel: true, footer: true, composer: false, sidebar: false }
check("picking panel leaves footer alone", applyChoice(both, "panel"), {
  panel: false,
  footer: true,
  composer: false,
  sidebar: false,
})
check("picking footer leaves panel alone", applyChoice(both, "footer"), {
  panel: true,
  footer: false,
  composer: false,
  sidebar: false,
})
check("picking an off placement turns only it on", applyChoice(both, "composer"), {
  panel: true,
  footer: true,
  composer: true,
  sidebar: false,
})
check("hide everywhere turns all off", applyChoice(both, "__off"), {
  panel: false,
  footer: false,
  composer: false,
  sidebar: false,
})
check("toggling twice returns to the start", applyChoice(applyChoice(both, "panel"), "panel"), both)

console.log("applySet")
check("sets one, keeps the rest", applySet(both, "sidebar", true), {
  panel: true,
  footer: true,
  composer: false,
  sidebar: true,
})
check("turns one off, keeps the rest", applySet(both, "panel", false), {
  panel: false,
  footer: true,
  composer: false,
  sidebar: false,
})

console.log("does not mutate its input")
const original: Display = { ...both }
applyChoice(original, "sidebar")
applySet(original, "panel", false)
check("input untouched", original, both)

console.log("misc")
check("isPlacement accepts known", isPlacement("panel"), true)
check("isPlacement rejects unknown", isPlacement("nope"), false)
check("describe lists on", describe(both), "panel, footer")
check("describe when none", describe(applyChoice(both, "__off")), "hidden everywhere")

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
