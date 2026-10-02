/**
 * Waiting on background work is not looping.
 *
 * An agent that started a twenty-minute build and has nothing else to do can only say
 * "still running" each turn. The reply-repeat and stall guards read that as a runaway and
 * pause the goal, even though the work is moving. This module answers one question — is a
 * background command this session started still unfinished? — so the loop can back off
 * instead of stopping.
 *
 * It fails open in both directions: a shape it does not recognise reports nothing pending,
 * so the ordinary guards stay in force, and the wait is bounded by the caller.
 */

const SHELL_ID = /\bsh_[A-Za-z0-9]+\b/g
/** The host reports a background child as `sessionID: ses_…` in the tool result. */
const CHILD_ID = /sessionID\\?["']?\s*[:=]\s*\\?["']?(ses_[A-Za-z0-9]+)/g

/**
 * Ids of background commands and background child sessions launched in these messages.
 *
 * A child session is only an id to wait on. The standing goal is not copied into it:
 * the child already has the prompt the parent wrote, and copying the goal would make
 * every worker try to finish the parent's whole contract.
 */
function launched(messages: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    const record = message as { type?: unknown; content?: unknown } | null
    if (record?.type !== "assistant") continue
    for (const part of (record.content ?? []) as readonly unknown[]) {
      const entry = part as {
        type?: unknown
        state?: { input?: { background?: unknown }; output?: unknown; content?: unknown }
      } | null
      if (entry?.type !== "tool" || entry.state?.input?.background !== true) continue
      const text = JSON.stringify([entry.state.content ?? "", entry.state.output ?? ""])
      for (const found of text.matchAll(new RegExp(SHELL_ID.source, "g"))) ids.push(found[0])
      for (const found of text.matchAll(new RegExp(CHILD_ID.source, "g"))) ids.push(found[1])
    }
  }
  return ids
}

/** True when a completion notice for this id appears anywhere after it started. */
function finished(id: string, messages: readonly unknown[]): boolean {
  for (const message of messages) {
    const record = message as { type?: unknown } | null
    if (record?.type === "assistant") continue
    const text = JSON.stringify(message)
    if (text.includes(id) && /state=\\?"(completed|failed|killed|timed_out)/.test(text)) return true
  }
  return false
}

/** Background commands and child sessions that have not reported completion. */
export function pendingBackground(messages: readonly unknown[]): string[] {
  return launched(messages).filter((id) => !finished(id, messages))
}

export function isChildSession(id: string): boolean {
  return id.startsWith("ses_")
}

function epoch(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  if (typeof value === "object") {
    const record = value as { epochMillis?: unknown; epochMilliseconds?: unknown }
    if (typeof record.epochMillis === "number") return record.epochMillis
    if (typeof record.epochMilliseconds === "number") return record.epochMilliseconds
  }
  return undefined
}

/**
 * Whether a host session record is still running. `time.idle` is set when a run
 * reaches a terminal transition; a later `time.updated` means a new run started.
 * A missing record is not alive: unknown must not burn the wait allowance.
 */
export function sessionBusy(info: {
  outcome?: string | null
  time?: { idle?: unknown; updated?: unknown } | null
} | null | undefined): boolean {
  if (!info) return false
  const idle = epoch(info.time?.idle)
  const updated = epoch(info.time?.updated)
  if (info.outcome) return idle != null && updated != null && updated > idle
  if (idle == null) return true
  return updated != null && updated > idle
}

/**
 * How many pending ids are definitely still running.
 *
 * A child session has no output file, so the file check does not apply. A missing
 * output path is unknown, not alive — treating it as alive waits out the allowance
 * and then times out. Liveness for `ses_*` is the session query the caller injects.
 */
export async function countPendingAlive(
  messages: readonly unknown[],
  probe: {
    fileOpen: (path: string) => Promise<boolean>
    sessionBusy: (id: string) => Promise<boolean>
  },
): Promise<number> {
  let alive = 0
  for (const id of pendingBackground(messages)) {
    if (isChildSession(id)) {
      if (await probe.sessionBusy(id)) alive++
      continue
    }
    const out = outputPathOf(messages, id)
    if (!out) continue
    if (await probe.fileOpen(out)) alive++
  }
  return alive
}

/** The allowance ran out. Names the pending ids. Never says to do other work. */
export function allowanceUsedMessage(pending: readonly string[]): string {
  const base = "The waiting allowance for this goal is used up."
  if (pending.length === 0) return base
  return `${base} Still pending: ${pending.join(", ")}. Do not start the same task again.`
}

/** A wait timed out with work still in flight. Never says to do other work. */
export function stillRunningMessage(minutes: number, pending: readonly string[]): string {
  const base = `Still running after ${minutes} min.`
  if (pending.length === 0) return `${base} Call goal_wait again if you must keep waiting.`
  return `${base} Still pending: ${pending.join(", ")}. Do not start the same task again. Call goal_wait again if you must keep waiting.`
}

/** Seconds to wait before the next prompt: 15s, doubling each wait, capped at two minutes. */
export function backoffSeconds(waits: number): number {
  return Math.min(120, 15 * 2 ** Math.max(0, waits))
}

/** Total time a goal may spend waiting on background work before the guards take over. */
export const MAX_WAIT_MS = 60 * 60 * 1000

export type WaitEnd = "finished" | "timeout" | "aborted" | "inactive"

/**
 * Hold a turn open until background work finishes, the time is up, the caller aborts, or
 * the goal stops being active. Polling is injected so this stays a pure, testable loop.
 * Holding the turn open is the point: no reply is produced, so nothing repeats.
 */
export async function waitForBackground(options: {
  seconds: number
  intervalMs: number
  pending: () => Promise<number>
  active: () => Promise<boolean>
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /**
   * How long "nothing pending" is distrusted when nothing has ever been seen pending. A command
   * launched in the same parallel block as this call is not in the context yet, so an early
   * empty reading is a race, not an answer.
   */
  graceMs?: number
}): Promise<{ end: WaitEnd; waitedMs: number }> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const started = now()
  const deadline = started + options.seconds * 1000
  const result = (end: WaitEnd) => ({ end, waitedMs: now() - started })
  const grace = options.graceMs ?? 0
  let seen = false
  for (;;) {
    if (options.signal?.aborted) return result("aborted")
    if (!(await options.active())) return result("inactive")
    if ((await options.pending()) > 0) seen = true
    else if (seen || now() - started >= grace) return result("finished")
    const left = deadline - now()
    if (left <= 0) return result("timeout")
    await sleep(Math.min(options.intervalMs, left))
  }
}

/** Where a background command streams its output, read from the launch notice. */
export function outputPathOf(messages: readonly unknown[], id: string): string | undefined {
  for (const message of messages) {
    const record = message as { type?: unknown; content?: unknown } | null
    if (record?.type !== "assistant") continue
    for (const part of (record.content ?? []) as readonly unknown[]) {
      const state = (part as { type?: unknown; state?: { content?: unknown } } | null)?.state
      const text = JSON.stringify(state?.content ?? "")
      if (!text.includes(id)) continue
      const found = new RegExp(`streaming to: (\\S*${id}\\.out)`).exec(text.replace(/\\n/g, " "))
      if (found) return found[1]
    }
  }
  return undefined
}

/**
 * The time spent waiting in the current episode. A goal can run for days, so the bound is on one stretch of
 * waiting on background work, not on the goal's lifetime: any turn that is not waiting starts a new episode.
 */
export function nextWaitedMs(previous: number, waiting: boolean, waitSeconds: number): number {
  return waiting ? previous + waitSeconds * 1000 : 0
}
