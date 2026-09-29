/**
 * Checks for the display picker. Run with: node display.test.ts
 *
 * The picker had a bug that only a person clicking through the dialog could
 * find, which is exactly the class of bug these exist to catch.
 */
import {
  applyParsed,
  applySet,
  DEFAULTS,
  describe,
  isPlacement,
  moveCursor,
  parseDisplayArgument,
  seedDisplay,
  toggleDraft,
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

// The original reported bug: toggling one placement silently switched the rest
// off. The dialog replaced the single-select picker, so this is now covered via
// applyParsed, which is what the command line and the dialog both go through.
const both: Display = { panel: true, footer: true, composer: false, sidebar: false }
check("toggling panel leaves footer alone", applyParsed(both, parseDisplayArgument("panel")), {
  panel: false,
  footer: true,
  composer: false,
  sidebar: false,
})
check("toggling footer leaves panel alone", applyParsed(both, parseDisplayArgument("footer")), {
  panel: true,
  footer: false,
  composer: false,
  sidebar: false,
})
check("toggling an off placement turns only it on", applyParsed(both, parseDisplayArgument("composer")), {
  panel: true,
  footer: true,
  composer: true,
  sidebar: false,
})

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
applySet(original, "panel", false)
check("input untouched", original, both)

console.log("parseDisplayArgument")
check("single placement", parseDisplayArgument("panel"), { placements: ["panel"], unknown: [] })
check("comma list", parseDisplayArgument("panel,composer,sidebar"), {
  placements: ["panel", "composer", "sidebar"],
  unknown: [],
})
check("space list", parseDisplayArgument("panel composer"), {
  placements: ["panel", "composer"],
  unknown: [],
})
check("mixed separators", parseDisplayArgument("panel, composer sidebar"), {
  placements: ["panel", "composer", "sidebar"],
  unknown: [],
})
check("explicit off", parseDisplayArgument("footer off"), { placements: ["footer"], enabled: false, unknown: [] })
check("explicit on", parseDisplayArgument("footer on"), { placements: ["footer"], enabled: true, unknown: [] })
check("truthy synonyms", parseDisplayArgument("footer yes"), { placements: ["footer"], enabled: true, unknown: [] })
check("falsy synonyms", parseDisplayArgument("footer no"), { placements: ["footer"], enabled: false, unknown: [] })
check("off before list", parseDisplayArgument("off panel,sidebar"), {
  placements: ["panel", "sidebar"],
  enabled: false,
  unknown: [],
})
check("duplicates collapse", parseDisplayArgument("panel,panel"), { placements: ["panel"], unknown: [] })
check("empty argument", parseDisplayArgument(""), { placements: [], unknown: [] })
check("unknown reported", parseDisplayArgument("nope"), { placements: [], unknown: ["nope"] })
check("known and unknown", parseDisplayArgument("panel,nope"), { placements: ["panel"], unknown: ["nope"] })

console.log("applyParsed")
const start: Display = { panel: true, footer: true, composer: false, sidebar: false }
check(
  "no on/off toggles each named",
  applyParsed(start, parseDisplayArgument("panel,composer")),
  { panel: false, footer: true, composer: true, sidebar: false },
)
check("explicit off sets only the named", applyParsed(start, parseDisplayArgument("panel,composer off")), {
  panel: false,
  footer: true,
  composer: false,
  sidebar: false,
})
check("explicit on sets only the named", applyParsed(start, parseDisplayArgument("sidebar on")), {
  panel: true,
  footer: true,
  composer: false,
  sidebar: true,
})
check("everything off in one go", applyParsed(start, parseDisplayArgument("panel,footer,composer,sidebar off")), {
  panel: false,
  footer: false,
  composer: false,
  sidebar: false,
})
check("no placements changes nothing", applyParsed(start, parseDisplayArgument("")), start)

console.log("moveCursor — the dialog's arrow keys")
check("down from the top", moveCursor(0, 1, 4), 1)
check("down wraps past the end", moveCursor(3, 1, 4), 0)
check("up from the top wraps to the end", moveCursor(0, -1, 4), 3)
check("up from the middle", moveCursor(2, -1, 4), 1)
check("empty list is safe", moveCursor(0, 1, 0), 0)

console.log("toggleDraft — space in the dialog")
const draftStart: Display = { panel: true, footer: true, composer: false, sidebar: false }
check("toggles the named one on", toggleDraft(draftStart, "composer"), {
  panel: true,
  footer: true,
  composer: true,
  sidebar: false,
})
check("toggles the named one off", toggleDraft(draftStart, "footer"), {
  panel: true,
  footer: false,
  composer: false,
  sidebar: false,
})
check("does not touch the others", Object.keys(toggleDraft(draftStart, "sidebar")).length, 4)
check("does not mutate the draft", draftStart, { panel: true, footer: true, composer: false, sidebar: false })

console.log("misc")
check("isPlacement accepts known", isPlacement("panel"), true)
check("isPlacement rejects unknown", isPlacement("nope"), false)
check("describe lists on", describe(both), "panel, footer")
check(
  "describe when none",
  describe(applyParsed(both, parseDisplayArgument("panel,footer,composer,sidebar off"))),
  "hidden everywhere",
)

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
