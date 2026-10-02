/**
 * A completion contract is the bar the judge clears.
 *
 * A one-line field (`verify: pytest …`, plus non-blank continuation lines) is the
 * form every goal written before fences used. A fenced field keeps its blank lines
 * and indentation, because those line breaks are the proof. An unknown fence is
 * left in the headline, so a goal that quotes a code block is not mangled. An
 * unclosed fence fails closed: it stays headline, and is not a swallowed field.
 */

export type Contract = {
  outcome?: string
  verification?: string
  constraints?: string
  boundaries?: string
  stopWhen?: string
  /** Commands the plugin runs after a first-pass `done`. Several entries, in order. */
  verifyCmd?: string[]
}

/** Only these prefixes are contract fields, so a goal that merely contains a colon
 *  ("Fix bug: the parser drops commas") is never mangled. */
export const FIELDS: Record<string, keyof Contract> = {
  outcome: "outcome",
  verify: "verification",
  "verified by": "verification",
  verification: "verification",
  constraints: "constraints",
  preserve: "constraints",
  boundaries: "boundaries",
  scope: "boundaries",
  "stop when": "stopWhen",
  "verify-cmd": "verifyCmd",
  "verified by running": "verifyCmd",
}

const FENCE_OPEN = /^```([a-z][a-z -]*)\s*$/i
const FENCE_CLOSE = /^```\s*$/
const FIELD_LINE = /^([a-z][a-z -]*):\s*(.*)$/i

function joinHeadline(chunks: string[]): string {
  if (chunks.some((chunk) => chunk.includes("\n"))) return chunks.join("\n")
  return chunks.join(" ")
}

function assign(contract: Contract, key: keyof Contract, text: string, fenced: boolean) {
  if (!text.trim()) return
  if (key === "verifyCmd") {
    contract.verifyCmd = [...(contract.verifyCmd ?? []), text]
    return
  }
  const prev = contract[key]
  if (!prev) {
    contract[key] = text
    return
  }
  contract[key] = fenced || prev.includes("\n") || text.includes("\n") ? `${prev}\n${text}` : `${prev} ${text}`
}

/** Split raw command text into a goal headline and its completion contract. */
export function parseGoal(raw: string): { goal: string; contract: Contract } {
  const lines = raw.split("\n")
  const headline: string[] = []
  const contract: Contract = {}
  let i = 0

  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i].trim())
    if (open) {
      const key = FIELDS[open[1].trim().toLowerCase()]
      const body: string[] = []
      let j = i + 1
      let closed = false
      while (j < lines.length) {
        if (FENCE_CLOSE.test(lines[j].trim())) {
          closed = true
          break
        }
        body.push(lines[j])
        j++
      }
      if (!key || !closed) {
        headline.push(lines.slice(i, closed ? j + 1 : lines.length).join("\n"))
        i = closed ? j + 1 : lines.length
        continue
      }
      assign(contract, key, body.join("\n"), true)
      i = j + 1
      continue
    }

    const match = FIELD_LINE.exec(lines[i].trim())
    const key = match ? FIELDS[match[1].trim().toLowerCase()] : undefined
    if (key && match![2].trim()) {
      const parts = [match![2].trim()]
      i++
      while (i < lines.length && lines[i].trim()) {
        if (FENCE_OPEN.test(lines[i].trim())) break
        const next = FIELD_LINE.exec(lines[i].trim())
        const nextKey = next ? FIELDS[next[1].trim().toLowerCase()] : undefined
        if (nextKey && next![2].trim()) break
        parts.push(lines[i].trim())
        i++
      }
      assign(contract, key, parts.join(" "), false)
      continue
    }

    if (lines[i].trim()) headline.push(lines[i].trim())
    i++
  }

  return { goal: joinHeadline(headline), contract }
}

function renderValue(label: string, value: string): string {
  if (!value.includes("\n")) return `- ${label}: ${value}`
  return `- ${label}:\n${value}`
}

/** A paragraph the judge and the continuation can both read. Fenced fields keep their breaks. */
export function renderContract(contract: Contract): string {
  const lines: string[] = []
  if (contract.outcome) lines.push(renderValue("Outcome", contract.outcome))
  if (contract.verification) lines.push(renderValue("Proof it is done", contract.verification))
  for (const command of contract.verifyCmd ?? []) {
    lines.push(renderValue("Verified by running", command))
  }
  if (contract.constraints) lines.push(renderValue("Must not change", contract.constraints))
  if (contract.boundaries) lines.push(renderValue("In scope", contract.boundaries))
  if (contract.stopWhen) lines.push(renderValue("Stop and ask when", contract.stopWhen))
  return lines.length ? `\n\n${lines.join("\n")}` : ""
}
