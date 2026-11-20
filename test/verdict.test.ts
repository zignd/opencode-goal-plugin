import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { parseVerdict } from "../src/verdict.ts"

describe("parseVerdict", () => {
  test("keeps the existing verdict, reason and achieved fields", () => {
    const parsed = parseVerdict('{"verdict":"continue","reason":"not yet","achieved":"edited a.ts"}')
    assert.deepEqual(parsed, { verdict: "continue", reason: "not yet", achieved: "edited a.ts" })
  })

  test("reads a met list of numbers and numeric strings, deduplicated and sorted", () => {
    const parsed = parseVerdict('{"verdict":"continue","reason":"x","met":[3,"1",3,0,-2,"no"]}')
    assert.deepEqual(parsed.met, [1, 3])
  })

  test("an explicit empty met list stays empty, while an absent one is undefined", () => {
    assert.deepEqual(parseVerdict('{"verdict":"continue","met":[]}').met, [])
    assert.equal(parseVerdict('{"verdict":"continue"}').met, undefined)
  })

  test("the legacy done shape also carries met", () => {
    const parsed = parseVerdict('{"done":true,"reason":"ok","met":[2]}')
    assert.equal(parsed.verdict, "done")
    assert.deepEqual(parsed.met, [2])
  })

  test("still rejects a non-JSON or unknown verdict", () => {
    assert.throws(() => parseVerdict("no json here"), /no JSON/)
    assert.throws(() => parseVerdict('{"verdict":"maybe"}'), /unknown verdict/)
  })
})
