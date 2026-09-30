import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { backoffSeconds, nextWaitedMs, outputPathOf, pendingBackground } from "../src/waiting.ts"

const launch = (id: string) => ({
  type: "assistant",
  content: [{ type: "tool", state: { input: { background: true }, output: `started ${id}` } }],
})
const notice = (id: string) => ({
  type: "synthetic",
  text: `<shell id="${id}" state="completed" command="make">`,
})

describe("pendingBackground", () => {
  test("reads the id from the tool result content, as the host reports it", () => {
    const message = {
      type: "assistant",
      content: [
        {
          type: "tool",
          state: { input: { background: true }, content: [{ type: "text", text: "moved (shell ID: sh_real9)." }] },
        },
      ],
    }
    assert.deepEqual(pendingBackground([message]), ["sh_real9"])
  })

  test("reports a background command with no completion notice", () => {
    assert.deepEqual(pendingBackground([launch("sh_abc123")]), ["sh_abc123"])
  })

  test("clears it once the completion notice arrives", () => {
    assert.deepEqual(pendingBackground([launch("sh_abc123"), notice("sh_abc123")]), [])
  })

  test("keeps an unfinished command when another one finished", () => {
    assert.deepEqual(
      pendingBackground([launch("sh_one"), launch("sh_two"), notice("sh_one")]),
      ["sh_two"],
    )
  })

  test("ignores foreground commands", () => {
    const message = { type: "assistant", content: [{ type: "tool", state: { input: {}, output: "sh_zzz" } }] }
    assert.deepEqual(pendingBackground([message]), [])
  })

  test("fails open on shapes it does not recognise", () => {
    assert.deepEqual(pendingBackground([null, {}, { type: "assistant", content: [{ type: "tool" }] }]), [])
  })
})

describe("backoffSeconds", () => {
  test("doubles from 15s and caps at two minutes", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9].map(backoffSeconds), [15, 30, 60, 120, 120, 120])
  })
})

import { waitForBackground } from "../src/waiting.ts"

describe("waitForBackground", () => {
  const clock = () => {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => void (t += ms) }
  }
  const base = { seconds: 100, intervalMs: 10_000, active: async () => true }

  test("returns as soon as nothing is pending", async () => {
    let calls = 0
    const c = clock()
    const out = await waitForBackground({ ...base, ...c, pending: async () => (++calls < 3 ? 1 : 0) })
    assert.equal(out.end, "finished")
    assert.equal(out.waitedMs, 20_000)
  })

  test("does not trust an early empty reading when nothing was ever seen pending", async () => {
    let calls = 0
    const c = clock()
    const out = await waitForBackground({
      ...base,
      ...c,
      graceMs: 8000,
      intervalMs: 2000,
      pending: async () => (++calls < 3 ? 0 : 1),
    })
    assert.equal(out.end, "timeout")
  })

  test("after the grace period an empty reading means finished", async () => {
    const out = await waitForBackground({ ...base, ...clock(), graceMs: 8000, intervalMs: 2000, pending: async () => 0 })
    assert.equal(out.end, "finished")
    assert.equal(out.waitedMs, 8000)
  })

  test("stops at the time limit while work is still pending", async () => {
    const out = await waitForBackground({ ...base, ...clock(), pending: async () => 1 })
    assert.equal(out.end, "timeout")
    assert.equal(out.waitedMs, 100_000)
  })

  test("stops when the caller aborts", async () => {
    const controller = new AbortController()
    controller.abort()
    const out = await waitForBackground({ ...base, ...clock(), signal: controller.signal, pending: async () => 1 })
    assert.equal(out.end, "aborted")
  })

  test("stops when the goal is paused or cleared", async () => {
    const out = await waitForBackground({ ...base, ...clock(), active: async () => false, pending: async () => 1 })
    assert.equal(out.end, "inactive")
  })
})

describe("outputPathOf", () => {
  test("reads the streaming path from the launch notice", () => {
    const message = {
      type: "assistant",
      content: [
        {
          type: "tool",
          state: {
            input: { background: true },
            content: [{ type: "text", text: "moved (shell ID: sh_a1).\nOutput is streaming to: /tmp/x/sh_a1.out" }],
          },
        },
      ],
    }
    assert.equal(outputPathOf([message], "sh_a1"), "/tmp/x/sh_a1.out")
    assert.equal(outputPathOf([message], "sh_other"), undefined)
  })
})

describe("nextWaitedMs", () => {
  test("adds to the running episode while waiting", () => {
    assert.equal(nextWaitedMs(60_000, true, 30), 90_000)
  })

  test("a turn that is not waiting starts a new episode, however long the goal has run", () => {
    assert.equal(nextWaitedMs(3_500_000, false, 0), 0)
  })
})
