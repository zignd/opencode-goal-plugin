/**
 * The resilient listener.
 *
 * The two cases that matter are the ones measured against the client's stock
 * `rpc.events.on`: a handler that throws once, and a stream that ends. Both left
 * a listener that was registered, looked alive, and never delivered again.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { listen } from "../src/listen.ts"

/** Resolve on the next macrotask, letting every queued microtask run first. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** An async iterable that yields the given events then ends. */
async function* finite<E>(...events: E[]): AsyncGenerator<E> {
  for (const event of events) yield event
}

/** Sleep that resolves at once and records what it was asked for. */
const instantSleep = (delays: number[]) => async (ms: number) => {
  delays.push(ms)
}

/**
 * Serves a queue of streams, one per connection, and stops the listener once
 * they run out so a test never loops forever.
 */
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

describe("listen", () => {
  test("delivers events in order", async () => {
    const seen: number[] = []
    let stop: () => void = () => {}
    const source = streams([() => finite(1, 2, 3)], () => stop())
    stop = listen(source.subscribe, (event: number) => void seen.push(event), {
      sleep: instantSleep([]),
    })
    await settle()
    assert.deepEqual(seen, [1, 2, 3])
    stop()
  })

  // Measured on the stock client: one throw ended the loop, so events 2 and 3
  // below never arrived.
  test("a handler that throws does not end the subscription", async () => {
    const seen: number[] = []
    const errors: unknown[] = []
    let stop: () => void = () => {}
    const source = streams([() => finite(1, 2, 3)], () => stop())
    stop = listen(
      source.subscribe,
      (event: number) => {
        seen.push(event)
        if (event === 1) throw new Error("boom")
      },
      { onError: (error) => errors.push(error), sleep: instantSleep([]) },
    )
    await settle()
    assert.deepEqual(seen, [1, 2, 3])
    assert.equal(errors.length, 1)
    stop()
  })

  test("a handler that rejects does not end the subscription either", async () => {
    const seen: number[] = []
    let stop: () => void = () => {}
    const source = streams([() => finite(1, 2)], () => stop())
    stop = listen(
      source.subscribe,
      async (event: number) => {
        seen.push(event)
        throw new Error("async boom")
      },
      { onError: () => {}, sleep: instantSleep([]) },
    )
    await settle()
    assert.deepEqual(seen, [1, 2])
    stop()
  })

  // Measured on the stock client: the stream ended after one event and nothing
  // ever opened a second connection, with no error to say so.
  test("reopens the stream when it ends", async () => {
    const seen: number[] = []
    let stop: () => void = () => {}
    const source = streams([() => finite(1), () => finite(2)], () => stop())
    stop = listen(source.subscribe, (event: number) => void seen.push(event), {
      sleep: instantSleep([]),
    })
    await settle()
    assert.deepEqual(seen, [1, 2])
    assert.ok(source.connections() >= 2)
    stop()
  })

  test("reopens the stream when it throws, and reports why", async () => {
    const seen: number[] = []
    const errors: string[] = []
    let stop: () => void = () => {}
    const source = streams(
      [
        async function* () {
          yield 1
          throw new Error("socket closed")
        },
        () => finite(2),
      ],
      () => stop(),
    )
    stop = listen(source.subscribe, (event: number) => void seen.push(event), {
      onError: (error) => errors.push((error as Error).message),
      sleep: instantSleep([]),
    })
    await settle()
    assert.deepEqual(seen, [1, 2])
    assert.deepEqual(errors, ["socket closed"])
    stop()
  })

  test("runs onResume between a gap and the reconnect, never before the first connection", async () => {
    const order: string[] = []
    let stop: () => void = () => {}
    const source = streams(
      [
        async function* () {
          order.push("stream 1")
          yield 1
        },
        async function* () {
          order.push("stream 2")
          yield 2
        },
      ],
      () => stop(),
    )
    stop = listen(source.subscribe, (event: number) => void order.push(`event ${event}`), {
      onResume: () => void order.push("resume"),
      sleep: instantSleep([]),
    })
    await settle()
    assert.deepEqual(order.slice(0, 5), ["stream 1", "event 1", "resume", "stream 2", "event 2"])
    stop()
  })

  test("says where each kind of failure came from", async () => {
    const phases: string[] = []
    let stop: () => void = () => {}
    const source = streams(
      [
        async function* () {
          yield 1
          throw new Error("stream")
        },
        () => finite(2),
      ],
      () => stop(),
    )
    stop = listen(
      source.subscribe,
      (event: number) => {
        if (event === 1) throw new Error("handler")
      },
      {
        onResume: () => {
          throw new Error("resume")
        },
        onError: (error, phase) => phases.push(`${phase}:${(error as Error).message}`),
        sleep: instantSleep([]),
      },
    )
    await settle()
    assert.deepEqual(phases.slice(0, 3), ["handler:handler", "stream:stream", "resume:resume"])
    stop()
  })

  test("a failing onResume does not stop the reconnect", async () => {
    const seen: number[] = []
    const errors: unknown[] = []
    let stop: () => void = () => {}
    const source = streams([() => finite(1), () => finite(2)], () => stop())
    stop = listen(source.subscribe, (event: number) => void seen.push(event), {
      onResume: () => {
        throw new Error("resync failed")
      },
      onError: (error) => errors.push(error),
      sleep: instantSleep([]),
    })
    await settle()
    assert.deepEqual(seen, [1, 2])
    assert.ok(errors.length >= 1)
    stop()
  })

  test("a throwing error sink cannot take the listener down", async () => {
    const seen: number[] = []
    let stop: () => void = () => {}
    const source = streams([() => finite(1, 2)], () => stop())
    stop = listen(
      source.subscribe,
      (event: number) => {
        seen.push(event)
        throw new Error("handler")
      },
      {
        onError: () => {
          throw new Error("sink")
        },
        sleep: instantSleep([]),
      },
    )
    await settle()
    assert.deepEqual(seen, [1, 2])
    stop()
  })

  test("backs off while the stream keeps ending empty, up to the ceiling", async () => {
    const delays: number[] = []
    let stop: () => void = () => {}
    const source = streams(
      [() => finite(), () => finite(), () => finite(), () => finite(), () => finite()],
      () => stop(),
    )
    stop = listen(source.subscribe, () => {}, {
      sleep: instantSleep(delays),
      minDelay: 100,
      maxDelay: 500,
    })
    await settle()
    assert.deepEqual(delays.slice(0, 5), [100, 200, 400, 500, 500])
    stop()
  })

  test("forgets the backoff once an event proves the connection is healthy", async () => {
    const delays: number[] = []
    let stop: () => void = () => {}
    const source = streams(
      [() => finite(), () => finite(), () => finite(1), () => finite()],
      () => stop(),
    )
    stop = listen(source.subscribe, () => {}, {
      sleep: instantSleep(delays),
      minDelay: 100,
      maxDelay: 10_000,
    })
    await settle()
    // Two empty gaps double the delay (100, 200). The third connection delivers
    // an event, which resets it, so the gap after that sleeps 100 again rather
    // than the 400 it would have reached, and then doubles from there.
    assert.deepEqual(delays.slice(0, 4), [100, 200, 100, 200])
    stop()
  })

  test("stopping aborts the signal handed to the stream", async () => {
    let received: AbortSignal | undefined
    const stop = listen(
      (signal) => {
        received = signal
        return (async function* () {
          await new Promise(() => {})
        })()
      },
      () => {},
      { sleep: instantSleep([]) },
    )
    await settle()
    assert.equal(received?.aborted, false)
    stop()
    assert.equal(received?.aborted, true)
  })

  test("does not reconnect once stopped", async () => {
    let connections = 0
    let stop: () => void = () => {}
    stop = listen(
      () => {
        connections++
        // subscribe runs synchronously inside listen(), before `stop` has been
        // assigned, so stopping has to wait a microtask to reach the real one.
        queueMicrotask(() => stop())
        return finite<number>()
      },
      () => {},
      { sleep: instantSleep([]) },
    )
    await settle()
    assert.equal(connections, 1)
  })

  test("stopping during the backoff sleep prevents the reconnect", async () => {
    let connections = 0
    let release: () => void = () => {}
    const stop = listen(
      () => {
        connections++
        return finite<number>()
      },
      () => {},
      {
        sleep: () => new Promise<void>((resolve) => (release = resolve)),
      },
    )
    await settle()
    assert.equal(connections, 1)
    stop()
    release()
    await settle()
    assert.equal(connections, 1)
  })

  test("the default sleep wakes as soon as the listener is stopped", async () => {
    let connections = 0
    const stop = listen(
      () => {
        connections++
        return finite<number>()
      },
      () => {},
      { minDelay: 60_000 },
    )
    await settle()
    const started = Date.now()
    stop()
    await settle()
    assert.ok(Date.now() - started < 1000)
    assert.equal(connections, 1)
  })

  test("waits the real delay before reconnecting when not stopped", async () => {
    let connections = 0
    const stop = listen(
      () => {
        connections++
        return finite<number>()
      },
      () => {},
      { minDelay: 40, maxDelay: 40 },
    )
    await new Promise((resolve) => setTimeout(resolve, 130))
    stop()
    assert.ok(connections >= 2, `expected a reconnect, saw ${connections} connection(s)`)
    assert.ok(connections <= 5, `expected backoff, saw ${connections} connections`)
  })
})
