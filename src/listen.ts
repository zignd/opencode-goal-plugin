/**
 * A subscription that survives.
 *
 * The client's own `rpc.events.on` is one `for await` loop with a catch at the
 * end, and nothing that restarts it. Measured against the real library:
 *
 *   - a handler that throws once ends the loop, so every later event is dropped
 *     and the error goes to `console.error`;
 *   - a stream that simply ends ends the loop with no error at all, and nothing
 *     opens a second connection.
 *
 * Either way the listener stays registered and looks alive while being
 * permanently deaf, and the UI it feeds stops updating until something else
 * refreshes it - here, reopening the panel, which reads state directly.
 *
 * `listen` fixes both. A handler error is reported and the next event is still
 * delivered; when the stream ends or fails it is reopened after a growing delay,
 * and `onResume` runs first so the caller can re-read whatever it missed while
 * nothing was listening.
 *
 * No dependency on the client, Solid or JSX, so it can be tested with plain
 * async iterables.
 */

export type Stop = () => void

/**
 * Where a failure came from. A dropped stream is routine and heals itself, while
 * a throwing handler is a bug, so callers usually want to treat them differently.
 */
export type Phase = "handler" | "stream" | "resume"

export interface ListenOptions {
  /**
   * Runs after a gap in delivery, before the stream is reopened. Events sent
   * during the gap are gone, so this is where the caller re-reads state. It is
   * not called before the first connection.
   */
  onResume?: () => void | Promise<void>
  /** Told about a failure and where it came from. May throw; that is contained. */
  onError?: (error: unknown, phase: Phase) => void
  /** Injectable so tests need not wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** First reconnect delay. Default 500ms. */
  minDelay?: number
  /** Ceiling for the doubling delay. Default 10s. */
  maxDelay?: number
}

const sleepUnlessAborted = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })

export function listen<E>(
  subscribe: (signal: AbortSignal) => AsyncIterable<E>,
  handler: (event: E) => void | Promise<void>,
  options: ListenOptions = {},
): Stop {
  const controller = new AbortController()
  const { signal } = controller
  const sleep = options.sleep ?? sleepUnlessAborted
  const minDelay = options.minDelay ?? 500
  const maxDelay = options.maxDelay ?? 10_000
  const report = (error: unknown, phase: Phase) => {
    try {
      options.onError?.(error, phase)
    } catch {
      // A broken error sink must not take the listener down with it.
    }
  }

  void (async () => {
    let delay = minDelay
    let reconnecting = false

    while (!signal.aborted) {
      if (reconnecting) {
        await sleep(delay, signal)
        if (signal.aborted) return
        delay = Math.min(delay * 2, maxDelay)
        try {
          await options.onResume?.()
        } catch (error) {
          report(error, "resume")
        }
        if (signal.aborted) return
      }
      reconnecting = true

      try {
        for await (const event of subscribe(signal)) {
          if (signal.aborted) return
          // Something arrived, so the connection is healthy: forget the backoff.
          delay = minDelay
          try {
            await handler(event)
          } catch (error) {
            report(error, "handler")
          }
        }
      } catch (error) {
        if (!signal.aborted) report(error, "stream")
      }
    }
  })()

  return () => controller.abort()
}

/**
 * The same reconnection `listen` gives, exposed as an async iterable so a `for await` body can keep
 * its own `continue`/`break` semantics. Where `listen` wraps a per-event handler, this wraps the
 * stream itself: a dropped or failed subscription is reopened with a growing delay, and the caller's
 * loop simply keeps receiving events. A stream that ends normally is also a reconnect — an ended
 * subscription is the same deafness as a failed one.
 */
export async function* reconnect<E>(
  subscribe: (signal: AbortSignal) => AsyncIterable<E>,
  options: {
    signal: AbortSignal
    minDelay?: number
    maxDelay?: number
    onError?: (error: unknown, phase: Phase) => void
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  },
): AsyncGenerator<E> {
  const { signal } = options
  const sleep = options.sleep ?? sleepUnlessAborted
  const minDelay = options.minDelay ?? 500
  const maxDelay = options.maxDelay ?? 10_000
  const report = (error: unknown, phase: Phase) => {
    try {
      options.onError?.(error, phase)
    } catch {
      // A broken error sink must not take the stream down with it.
    }
  }
  let delay = minDelay
  let reconnecting = false

  while (!signal.aborted) {
    if (reconnecting) {
      await sleep(delay, signal)
      if (signal.aborted) return
      delay = Math.min(delay * 2, maxDelay)
    }
    reconnecting = true

    try {
      for await (const event of subscribe(signal)) {
        if (signal.aborted) return
        // Something arrived, so the connection is healthy: forget the backoff.
        delay = minDelay
        yield event
      }
    } catch (error) {
      if (!signal.aborted) report(error, "stream")
    }
  }
}
