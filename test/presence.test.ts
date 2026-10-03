import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { presentFor, samePlace, trimDir } from "../src/presence.ts"

const TTL = 5 * 60 * 1000

describe("samePlace", () => {
  test("a trailing slash is the same place", () => {
    assert.equal(samePlace("/work/app/", "/work/app"), true)
    assert.equal(trimDir("/"), "/")
  })

  test("a session in a subdirectory of the TUI's directory, and the reverse, match", () => {
    assert.equal(samePlace("/work/app/packages/web", "/work/app"), true)
    assert.equal(samePlace("/work/app", "/work/app/packages/web"), true)
  })

  test("a longer name that only starts the same does not match", () => {
    assert.equal(samePlace("/work/app", "/work/app-two"), false)
    assert.equal(samePlace("/work/a", "/other/a"), false)
  })
})

describe("presentFor", () => {
  const now = 1_000_000
  const fresh = { at: now - 1000, directory: "/work/app" }

  test("a fresh record for the same directory is present", () => {
    assert.equal(presentFor([fresh], "/work/app", now, TTL), true)
  })

  test("a stale record is not", () => {
    assert.equal(presentFor([{ at: now - TTL - 1, directory: "/work/app" }], "/work/app", now, TTL), false)
  })

  test("two spellings of one directory match through the canonical form", () => {
    const canonical = (path: string) => path.replace("/link", "/real")
    assert.equal(presentFor([{ at: now, directory: "/real/app" }], "/link/app", now, TTL, canonical), true)
    assert.equal(presentFor([{ at: now, directory: "/real/app" }], "/link/app", now, TTL), false)
  })

  test("a record for another project, or with no directory, is not present", () => {
    assert.equal(presentFor([{ at: now, directory: "/elsewhere" }], "/work/app", now, TTL), false)
    assert.equal(presentFor([{ at: now }], "/work/app", now, TTL), false)
    assert.equal(presentFor([], "/work/app", now, TTL), false)
  })
})
