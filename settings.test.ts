/**
 * The session settings.
 *
 * Each setting has a parser that a person types into and a summary they read
 * back, so both are pinned here. The resolve() cases are the ones that matter
 * most: they decide which value the loop actually obeys.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
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

const OPTIONS = { maxTurns: 20 as const, stall: DEFAULT_STALL, quiet: false, judge: null }

describe("parseCount", () => {
  test("reads a whole number", () => {
    assert.deepEqual(parseCount("5", "stall"), { kind: "value", value: 5 })
    assert.deepEqual(parseCount("1", "stall"), { kind: "value", value: 1 })
  })

  test("tolerates padding", () => {
    assert.deepEqual(parseCount("  4 ", "stall"), { kind: "value", value: 4 })
  })

  for (const word of ["default", "reset", "unset", "clear", "none", "off"]) {
    test(`reads "${word}" as a clear`, () => {
      assert.deepEqual(parseCount(word, "stall"), { kind: "clear" })
    })
  }

  for (const input of ["0", "-2", "2.5", "lots", "  "]) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      assert.deepEqual(parseCount(input, "stall"), { kind: "invalid" })
    })
  }
})

describe("parseFlag", () => {
  for (const word of ["on", "true", "yes", "1", "enable", "enabled", "ON"]) {
    test(`reads "${word}" as on`, () => {
      assert.deepEqual(parseFlag(word), { kind: "value", value: true })
    })
  }

  for (const word of ["off", "false", "no", "0", "disable", "disabled"]) {
    test(`reads "${word}" as off`, () => {
      assert.deepEqual(parseFlag(word), { kind: "value", value: false })
    })
  }

  for (const word of ["default", "reset", "unset"]) {
    test(`reads "${word}" as a clear`, () => {
      assert.deepEqual(parseFlag(word), { kind: "clear" })
    })
  }

  for (const input of ["", "maybe"]) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      assert.deepEqual(parseFlag(input), { kind: "invalid" })
    })
  }
})

describe("parseModel", () => {
  test("reads provider and model", () => {
    assert.deepEqual(parseModel("openrouter/google/gemini-3-flash-preview"), {
      kind: "value",
      value: { providerID: "openrouter", id: "google/gemini-3-flash-preview" },
    })
  })

  // Model ids very often contain slashes of their own, so splitting on the first
  // one is the only rule that accepts real references.
  test("keeps a slashed model id intact", () => {
    assert.deepEqual(parseModel("openrouter/perceptron/perceptron-mk1.5"), {
      kind: "value",
      value: { providerID: "openrouter", id: "perceptron/perceptron-mk1.5" },
    })
  })

  test("reads a simple reference", () => {
    assert.deepEqual(parseModel("anthropic/claude-sonnet-4-5"), {
      kind: "value",
      value: { providerID: "anthropic", id: "claude-sonnet-4-5" },
    })
  })

  test("reads a variant", () => {
    assert.deepEqual(parseModel("openai/gpt-5#high"), {
      kind: "value",
      value: { providerID: "openai", id: "gpt-5", variant: "high" },
    })
  })

  for (const word of ["default", "reset", "unset", "clear", "none", "session"]) {
    test(`reads "${word}" as a clear`, () => {
      assert.deepEqual(parseModel(word), { kind: "clear" })
    })
  }

  for (const input of ["gpt-5", "openai/", "/gpt-5", ""]) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      assert.deepEqual(parseModel(input), { kind: "invalid" })
    })
  }
})

describe("resolve", () => {
  test("with nothing overridden, the options win", () => {
    assert.deepEqual(resolve(OPTIONS, NO_OVERRIDES), {
      maxTurns: 20,
      stall: 2,
      quiet: false,
      judge: null,
      overridden: { maxTurns: false, stall: false, quiet: false, judge: false },
    })
  })

  // The regression this file exists for. Absent and unlimited were both spelled
  // null, so setting unlimited looked like it had done nothing and the
  // configured default silently won.
  test("an explicit unlimited override beats the configured default", () => {
    assert.deepEqual(resolve(OPTIONS, { ...NO_OVERRIDES, maxTurns: null }), {
      maxTurns: null,
      stall: 2,
      quiet: false,
      judge: null,
      overridden: { maxTurns: true, stall: false, quiet: false, judge: false },
    })
  })

  test("an absent override leaves the default alone", () => {
    assert.equal(resolve(OPTIONS, NO_OVERRIDES).maxTurns, 20)
  })

  test("only the overridden settings change", () => {
    const mixed: Overrides = { maxTurns: undefined, stall: 5, quiet: true, judge: undefined }
    assert.deepEqual(resolve(OPTIONS, mixed), {
      maxTurns: 20,
      stall: 5,
      quiet: true,
      judge: null,
      overridden: { maxTurns: false, stall: true, quiet: true, judge: false },
    })
  })

  test("a judge override is reported as overridden", () => {
    const judge = { providerID: "a", id: "b" }
    const resolved = resolve(OPTIONS, { ...NO_OVERRIDES, judge })
    assert.deepEqual(resolved.judge, judge)
    assert.equal(resolved.overridden.judge, true)
  })

  test("a judge override beats the configured one", () => {
    const judge = { providerID: "a", id: "b" }
    const resolved = resolve({ ...OPTIONS, judge: { providerID: "c", id: "d" } }, {
      ...NO_OVERRIDES,
      judge,
    })
    assert.deepEqual(resolved.judge, judge)
  })
})

describe("modelLabel", () => {
  test("renders a reference", () => {
    assert.equal(modelLabel({ providerID: "openai", id: "gpt-5" }), "openai/gpt-5")
  })

  test("renders a variant", () => {
    assert.equal(
      modelLabel({ providerID: "openai", id: "gpt-5", variant: "high" }),
      "openai/gpt-5#high",
    )
  })

  test("says when there is no override", () => {
    assert.equal(modelLabel(null), "the session's model")
  })
})

describe("renderSettings", () => {
  const rendered = renderSettings(
    resolve({ ...OPTIONS, maxTurns: null }, { ...NO_OVERRIDES, stall: 4, quiet: true }),
  )

  test("shows an unlimited budget", () => {
    assert.match(rendered, /Turn budget {2,}unlimited/)
  })

  test("shows the stall override", () => {
    assert.ok(rendered.includes("Stall limit   4 turns with no tools"), rendered)
  })

  test("shows quiet as on", () => {
    assert.ok(rendered.includes("Quiet mode    on"), rendered)
  })

  test("marks an override as belonging to this session", () => {
    assert.match(rendered, /this session/)
  })

  test("marks an untouched setting as the config default", () => {
    assert.match(rendered, /config default/)
  })

  test("lists the setters", () => {
    for (const command of ["/goal budget", "/goal stall", "/goal quiet", "/goal judge"]) {
      assert.ok(rendered.includes(command), `${command} missing from the summary`)
    }
  })

  test("says panel and display are TUI-only", () => {
    assert.match(rendered, /TUI-only/)
  })

  // The other side of both ternaries in the renderer: a finite budget and quiet
  // off, which is what the summary looks like before anything is overridden.
  const untouched = renderSettings(resolve(OPTIONS, NO_OVERRIDES))
  test("shows a finite budget as a count", () => {
    assert.ok(untouched.includes("Turn budget   20"), untouched)
  })
  test("shows quiet as off", () => {
    assert.ok(untouched.includes("Quiet mode    off"), untouched)
  })
  // Count the parenthesised row markers, not the bare words: the closing
  // paragraph legitimately mentions both "config default" and "this session".
  test("marks all four rows as the config default when nothing is set", () => {
    assert.equal(untouched.match(/\(config default\)/g)?.length, 4)
    assert.equal(untouched.match(/\(this session\)/g), null)
  })
})
