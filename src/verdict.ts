import type { Verdict } from "./verify.js"

/**
 * The judge's one line of JSON. `achieved` is optional: a judge that omits it is
 * still valid. `met` is optional too, but when subgoals exist it is the judge's
 * report of which criteria are now satisfied.
 */
export type ParsedVerdict = {
  verdict: Verdict
  reason: string
  achieved: string
  /** 1-based subgoal numbers, deduplicated. Undefined when the judge omitted the field. */
  met?: number[]
}

/** Numbers or numeric strings, deduplicated, positive integers only. */
function parseMet(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<number>()
  for (const item of value) {
    const n =
      typeof item === "number"
        ? item
        : typeof item === "string" && /^\d+$/.test(item.trim())
          ? Number.parseInt(item.trim(), 10)
          : Number.NaN
    if (Number.isInteger(n) && n >= 1) seen.add(n)
  }
  return [...seen].sort((a, b) => a - b)
}

export function parseVerdict(raw: string): ParsedVerdict {
  const match = /\{[\s\S]*\}/.exec(raw)
  if (!match) throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`)
  const parsed = JSON.parse(match[0]) as {
    verdict?: string
    reason?: string
    done?: boolean
    achieved?: unknown
    met?: unknown
  }
  const achieved = typeof parsed.achieved === "string" ? parsed.achieved : ""
  const met = parseMet(parsed.met)
  // The legacy {"done": bool, "reason": string} shape is still accepted.
  if (parsed.done !== undefined && !parsed.verdict) {
    return {
      verdict: parsed.done ? "done" : "continue",
      reason: parsed.reason ?? "",
      achieved,
      ...(met ? { met } : {}),
    }
  }
  if (parsed.verdict !== "done" && parsed.verdict !== "blocked" && parsed.verdict !== "continue") {
    throw new Error(`judge returned an unknown verdict: ${parsed.verdict}`)
  }
  return {
    verdict: parsed.verdict,
    reason: parsed.reason ?? "",
    achieved,
    ...(met ? { met } : {}),
  }
}
