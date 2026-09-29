/**
 * Turning a turn's tool calls into one stable observation string.
 *
 * The point of this is narrow and specific: an agent waiting on a long build produces a
 * turn that calls tools, says something new, and learns nothing. That defeats both of the
 * loop's existing no-progress checks — the reply digest moves, so the reply-repetition
 * guard never fires, and the tool count is non-zero, so the stall guard never fires. Only
 * the judge noticed, and its answer was to declare the *goal* unachievable from
 * turn-level evidence.
 *
 * So this digests what the tool calls *reported*, not what the agent said or asked for.
 * Two deliberate choices:
 *
 * - Tool inputs are skipped. An agent that reworded the same command each turn was still
 *   reading the same unchanged result, and that is precisely the case worth catching.
 * - It fails open. An unrecognised state shape yields an empty digest, and the guard
 *   stays quiet, because a heuristic that pauses a loop on a guess is worse than one
 *   that misses.
 */

/** Keys that describe *how* the tool was called rather than what it found. */
const CALL_SHAPE = new Set(["input", "args", "description", "title", "callID", "id"])

/** Everything a turn's tool calls reported, as one stable string. */
export function observationOf(messages: readonly unknown[]): string {
  const parts: string[] = []
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 6 || value === null || value === undefined) return
    if (typeof value === "string") {
      parts.push(value)
      return
    }
    if (typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (typeof value === "object")
      for (const [key, nested] of Object.entries(value as Record<string, unknown>))
        if (!CALL_SHAPE.has(key)) walk(nested, depth + 1)
  }

  for (const message of messages) {
    const record = message as { type?: unknown; content?: unknown } | null
    if (record?.type !== "assistant") continue
    for (const part of (record.content ?? []) as readonly unknown[]) {
      const entry = part as { type?: unknown; state?: unknown } | null
      if (entry?.type === "tool") walk(entry.state)
    }
  }
  return parts.join("\n")
}
