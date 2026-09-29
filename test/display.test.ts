/**
 * The display picker.
 *
 * The picker had a bug only a person clicking through the dialog could find:
 * toggling one placement silently switched the others off. That is the class
 * of bug these exist to catch, and the reason the selection logic lives in
 * display.ts as pure functions rather than inline in tui.tsx.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  applyAll,
  applyParsed,
  applySet,
  DEFAULTS,
  describe as summarise,
  isPlacement,
  parseDisplayArgument,
  seedDisplay,
  type Display,
} from "../src/display.ts"

const BOTH: Display = { panel: true, footer: true, composer: false, sidebar: false }

describe("seedDisplay", () => {
  test("uses the defaults with no options", () => {
    assert.deepEqual(seedDisplay(undefined), DEFAULTS)
  })

  test("honours a single override", () => {
    assert.deepEqual(seedDisplay({ panel: false }), {
      panel: false,
      footer: true,
      composer: false,
      sidebar: false,
    })
  })

  test("ignores unknown keys", () => {
    assert.deepEqual(seedDisplay({ nope: true, sidebar: true }), {
      panel: true,
      footer: true,
      composer: false,
      sidebar: true,
    })
  })

  test("ignores non-boolean values", () => {
    assert.deepEqual(seedDisplay({ panel: "yes" }), DEFAULTS)
  })
})

describe("the reported bug: toggling one placement", () => {
  // The dialog has since been replaced by the native picker, so this is covered
  // through applyParsed, which is what both the picker and the command line use.
  test("panel leaves footer alone", () => {
    assert.deepEqual(applyParsed(BOTH, parseDisplayArgument("panel")), {
      panel: false,
      footer: true,
      composer: false,
      sidebar: false,
    })
  })

  test("footer leaves panel alone", () => {
    assert.deepEqual(applyParsed(BOTH, parseDisplayArgument("footer")), {
      panel: true,
      footer: false,
      composer: false,
      sidebar: false,
    })
  })

  test("turning an off placement on affects only it", () => {
    assert.deepEqual(applyParsed(BOTH, parseDisplayArgument("composer")), {
      panel: true,
      footer: true,
      composer: true,
      sidebar: false,
    })
  })
})

describe("applyAll", () => {
  test("clears every placement", () => {
    assert.deepEqual(applyAll(false), {
      panel: false,
      footer: false,
      composer: false,
      sidebar: false,
    })
  })

  test("sets every placement", () => {
    assert.deepEqual(applyAll(true), {
      panel: true,
      footer: true,
      composer: true,
      sidebar: true,
    })
  })
})

describe("applySet", () => {
  test("turns one on and keeps the rest", () => {
    assert.deepEqual(applySet(BOTH, "sidebar", true), {
      panel: true,
      footer: true,
      composer: false,
      sidebar: true,
    })
  })

  test("turns one off and keeps the rest", () => {
    assert.deepEqual(applySet(BOTH, "panel", false), {
      panel: false,
      footer: true,
      composer: false,
      sidebar: false,
    })
  })

  test("does not mutate its input", () => {
    const original: Display = { ...BOTH }
    applySet(original, "panel", false)
    applyAll(true)
    assert.deepEqual(original, BOTH)
  })
})

describe("parseDisplayArgument", () => {
  test("reads a single placement", () => {
    assert.deepEqual(parseDisplayArgument("panel"), { placements: ["panel"], unknown: [] })
  })

  test("reads a comma separated list", () => {
    assert.deepEqual(parseDisplayArgument("panel,composer,sidebar"), {
      placements: ["panel", "composer", "sidebar"],
      unknown: [],
    })
  })

  test("reads a space separated list", () => {
    assert.deepEqual(parseDisplayArgument("panel composer"), {
      placements: ["panel", "composer"],
      unknown: [],
    })
  })

  test("accepts mixed separators", () => {
    assert.deepEqual(parseDisplayArgument("panel, composer sidebar"), {
      placements: ["panel", "composer", "sidebar"],
      unknown: [],
    })
  })

  test("collapses duplicates", () => {
    assert.deepEqual(parseDisplayArgument("panel,panel"), { placements: ["panel"], unknown: [] })
  })

  test("reads an explicit off", () => {
    assert.deepEqual(parseDisplayArgument("footer off"), {
      placements: ["footer"],
      enabled: false,
      unknown: [],
    })
  })

  test("reads an explicit on", () => {
    assert.deepEqual(parseDisplayArgument("footer on"), {
      placements: ["footer"],
      enabled: true,
      unknown: [],
    })
  })

  for (const [word, enabled] of [
    ["yes", true],
    ["no", false],
  ]) {
    test(`reads "${word}" as ${enabled ? "on" : "off"}`, () => {
      assert.deepEqual(parseDisplayArgument(`footer ${word}`), {
        placements: ["footer"],
        enabled,
        unknown: [],
      })
    })
  }

  test("accepts off before the list", () => {
    assert.deepEqual(parseDisplayArgument("off panel,sidebar"), {
      placements: ["panel", "sidebar"],
      enabled: false,
      unknown: [],
    })
  })

  test("reads an empty argument as nothing named", () => {
    assert.deepEqual(parseDisplayArgument(""), { placements: [], unknown: [] })
  })

  test("reports an unknown name", () => {
    assert.deepEqual(parseDisplayArgument("nope"), { placements: [], unknown: ["nope"] })
  })

  test("reports an unknown name alongside a known one", () => {
    assert.deepEqual(parseDisplayArgument("panel,nope"), {
      placements: ["panel"],
      unknown: ["nope"],
    })
  })
})

describe("applyParsed", () => {
  test("toggles each named placement when no on/off is given", () => {
    assert.deepEqual(applyParsed(BOTH, parseDisplayArgument("panel,composer")), {
      panel: false,
      footer: true,
      composer: true,
      sidebar: false,
    })
  })

  test("an explicit off clears only the named placements", () => {
    assert.deepEqual(applyParsed(BOTH, parseDisplayArgument("panel,composer off")), {
      panel: false,
      footer: true,
      composer: false,
      sidebar: false,
    })
  })

  test("an explicit on sets only the named placements", () => {
    assert.deepEqual(applyParsed(BOTH, parseDisplayArgument("sidebar on")), {
      panel: true,
      footer: true,
      composer: false,
      sidebar: true,
    })
  })

  test("can clear everything in one go", () => {
    assert.deepEqual(
      applyParsed(BOTH, parseDisplayArgument("panel,footer,composer,sidebar off")),
      { panel: false, footer: false, composer: false, sidebar: false },
    )
  })

  test("names nothing, changes nothing", () => {
    assert.deepEqual(applyParsed(BOTH, parseDisplayArgument("")), BOTH)
  })
})

describe("isPlacement", () => {
  test("accepts a known placement", () => {
    assert.equal(isPlacement("panel"), true)
  })

  test("rejects an unknown one", () => {
    assert.equal(isPlacement("nope"), false)
  })
})

describe("summarise", () => {
  test("lists the placements that are on", () => {
    assert.equal(summarise(BOTH), "panel, footer")
  })

  test("says so when none are", () => {
    assert.equal(summarise(applyAll(false)), "hidden everywhere")
  })
})
