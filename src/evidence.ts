/**
 * The off-screen record the judge is allowed to trust.
 *
 * Distinct from `observationOf`, which feeds the poll guard and ignores tool inputs.
 * Mixing them would make a genuine new proof look like a repeated observation.
 * This digest is not cleared because the latest reply failed to quote it.
 */

import { capText } from "./cap.js"

export const EVIDENCE_CAP = 8

export type EvidenceEntry = {
  command: string
  exit: number | null
  output: string
  timedOut?: boolean
}

export type EvidenceDigest = {
  entries: EvidenceEntry[]
  dropped: number
  pending: string[]
}

export function emptyDigest(): EvidenceDigest {
  return { entries: [], dropped: 0, pending: [] }
}

/** Keep the newest `cap` entries. The dropped count is the record of what fell off. */
export function appendEvidence(
  digest: EvidenceDigest,
  entry: EvidenceEntry,
  cap = EVIDENCE_CAP,
): EvidenceDigest {
  const entries = [...digest.entries, { ...entry, output: capText(entry.output) }]
  let dropped = digest.dropped
  while (entries.length > cap) {
    entries.shift()
    dropped++
  }
  return { ...digest, entries, dropped }
}

export function withPending(digest: EvidenceDigest, pending: readonly string[]): EvidenceDigest {
  return { ...digest, pending: [...pending] }
}

/**
 * Always a block. An omitted block reads as "nothing was ever proved", which is a
 * different claim from "nothing has been recorded yet".
 */
export function renderEvidence(digest: EvidenceDigest | undefined): string {
  if (!digest || (digest.entries.length === 0 && digest.pending.length === 0 && digest.dropped === 0)) {
    return "<evidence>\nNo proof has been recorded yet.\n</evidence>"
  }
  const lines = ["<evidence>"]
  if (digest.dropped > 0) lines.push(`${digest.dropped} earlier entries dropped.`)
  if (digest.pending.length) lines.push(`Still pending: ${digest.pending.join(", ")}`)
  if (digest.entries.length === 0) lines.push("No command output has been recorded yet.")
  for (const entry of digest.entries) {
    const exit = entry.timedOut ? "timeout" : String(entry.exit)
    lines.push(`$ ${entry.command}`, `exit: ${exit}`, entry.output)
  }
  lines.push("</evidence>")
  return lines.join("\n")
}
