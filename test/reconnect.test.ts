/**
 * The resilient stream.
 *
 * `listen` wraps a per-event handler; the goal engine keeps its own `for await` body, so it needs the
 * reconnection as an iterable (`reconnect`). The bug this guards against is the one that was live:
 * `src/server.ts` subscribed with a bare `for await`, the stream ended or threw (a server restart is
 * the usual cause), and the goal stayed `active` — reading "running" — while nothing was judged again
 * and even a user message no longer paused it. These cases pin that the stream comes back.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { reconnect, type Phase } from "../src/listen.ts"

/** Resolve on the next macrotask, letting every queued microtask run first. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** An async iterable that yields the given events then ends. */
async function* finite<E>(...events: E[]): AsyncGenerator<E> {
  for (const event of events) yield event
}

/** An async iterable that throws after yielding the given events. */
async function* failing<E>(error: unknown, ...events: E[]): AsyncGenerator<E> {
  for (const event of events) yield event
  throw error
}

/** Sleep that resolves at once and records what it was asked for. */
const instantSleep = (delays: number[]) => async (ms: number) => {
  delays.push(ms)
}

/** Serves a queue of streams, one per connection, and stops the stream once they run out. */
function streams<E>(plan: Array<() => AsyncIterable<E>>, stop: () => void) {
  let connections = 0
  const subscribe = (signal: AbortSignal) => {
    const make = plan[connections++]
    if (!make) {
      stop()
      return finite<E>()
    }
    void signal
    return make()
  }
  return { subscribe, connections: () => connections }
}

async function collect<E>(source: AsyncIterable<E>, limit: number, stop: () => void) {
  const seen: E[] = []
  for await (const event of source) {
    seen.push(event)
    if (seen.length >= limit) stop()
  }
  return seen
}

describe("reconnect", () => {
  test("keeps delivering after a stream ends, so a dropped subscription is not deafness", async () => {
    const controller = new AbortController()
    const delays: number[] = []
    const plan = streams<string>([() => finite("a", "b"), () => finite("c"), () => finite("d")], () =>
      controller.abort(),
    )
    const seen = await collect(
      reconnect(plan.subscribe, { signal: controller.signal, sleep: instantSleep(delays) }),
      4,
      () => controller.abort(),
    )
    assert.deepEqual(seen, ["a", "b", "c", "d"])
    // Three connections served a,b | c | d; the abort ends it before a fourth could be opened.
    assert.equal(plan.connections(), 3)
  })

  test("keeps delivering after a stream throws, and reports the failure", async () => {
    const controller = new AbortController()
    const delays: number[] = []
    const phases: Phase[] = []
    const boom = new Error("stream ended")
    const plan = streams<string>([() => failing(boom, "a"), () => finite("b")], () => controller.abort())
    const seen = await collect(
      reconnect(plan.subscribe, {
        signal: controller.signal,
        sleep: instantSleep(delays),
        onError: (_error, phase) => phases.push(phase),
      }),
      2,
      () => controller.abort(),
    )
    assert.deepEqual(seen, ["a", "b"])
    assert.deepEqual(phases, ["stream"])
  })

  test("backs off while nothing arrives and forgets it once an event does", async () => {
    const controller = new AbortController()
    const delays: number[] = []
    // Three empty connections, then one that greets; a healthy connection must reset the delay.
    const plan = streams<string>([() => finite(), () => finite(), () => finite(), () => finite("hi")], () =>
      controller.abort(),
    )
    const seen = await collect(
      reconnect(plan.subscribe, { signal: controller.signal, minDelay: 100, sleep: instantSleep(delays) }),
      1,
      () => controller.abort(),
    )
    assert.deepEqual(seen, ["hi"])
    // 100 (maybe doubled by the reconnect bookkeeping) climbing to the cap of 10s, never past it.
    assert.ok(delays.length >= 3, `expected several waits, got ${JSON.stringify(delays)}`)
    assert.ok(delays.every((ms) => ms <= 10_000), `delays capped at 10s: ${JSON.stringify(delays)}`)
    assert.ok(delays[0] === 100, `the first wait is the minimum: ${delays[0]}`)
    assert.ok(
      delays.some((ms) => ms > 100),
      `the wait grows while nothing arrives: ${JSON.stringify(delays)}`,
    )
  })

  test("stops for good when the signal aborts", async () => {
    const controller = new AbortController()
    const delays: number[] = []
    let connections = 0
    const subscribe = () => {
      connections++
      controller.abort()
      return finite<string>()
    }
    const seen = await collect(
      reconnect(subscribe, { signal: controller.signal, sleep: instantSleep(delays) }),
      1,
      () => controller.abort(),
    )
    assert.deepEqual(seen, [])
    assert.equal(connections, 1)
  })

  test("a throwing error sink does not take the stream down", async () => {
    const controller = new AbortController()
    const delays: number[] = []
    const plan = streams<string>([() => failing(new Error("x"), "a"), () => finite("b")], () =>
      controller.abort(),
    )
    const seen = await collect(
      reconnect(plan.subscribe, {
        signal: controller.signal,
        sleep: instantSleep(delays),
        onError: () => {
          throw new Error("the sink is broken too")
        },
      }),
      2,
      () => controller.abort(),
    )
    // Give the rejected report a turn to land before asserting nothing escaped.
    await settle()
    assert.deepEqual(seen, ["a", "b"])
  })
})
