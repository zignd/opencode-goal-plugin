import type { Verdict } from "./verify.js"

/** The judge's one line of JSON. `achieved` is optional: a judge that omits it is still valid. */
export function parseVerdict(raw: string): { verdict: Verdict; reason: string; achieved: string } {
  const match = /\{[\s\S]*\}/.exec(raw)
  if (!match) throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`)
  const parsed = JSON.parse(match[0]) as {
    verdict?: string
    reason?: string
    done?: boolean
    achieved?: unknown
  }
  const achieved = typeof parsed.achieved === "string" ? parsed.achieved : ""
  // The legacy {"done": bool, "reason": string} shape is still accepted.
  if (parsed.done !== undefined && !parsed.verdict) {
    return { verdict: parsed.done ? "done" : "continue", reason: parsed.reason ?? "", achieved }
  }
  if (parsed.verdict !== "done" && parsed.verdict !== "blocked" && parsed.verdict !== "continue") {
    throw new Error(`judge returned an unknown verdict: ${parsed.verdict}`)
  }
  return { verdict: parsed.verdict, reason: parsed.reason ?? "", achieved }
}
