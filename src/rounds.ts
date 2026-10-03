/**
 * What the server records about each round, and how it reads on screen.
 *
 * Pure and host-free so the server, the TUI, and the tests share one definition. A round
 * is one turn from the moment the plugin sent the prompt to the moment the turn settled.
 * Judge time is not part of it, and neither is the backoff sleep before the prompt.
 */

export type RoundOutcome = "continue" | "done" | "blocked" | "paused" | "failed" | "interrupted"

export type Round = {
  /** 1-based, matching the turn counter the user sees. */
  n: number
  startedAt: number
  endedAt: number
  ms: number
  toolCalls: number
  outcome: RoundOutcome
  reason: string
  achieved: string
  /** True when the judge gave no summary and `achieved` is only a plain fact line. */
  fallback?: boolean
}

export const MAX_ROUNDS = 40
export const MAX_ACHIEVED = 400

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function capText(text: string, max = MAX_ACHIEVED): string {
  const clean = text.replace(/\s+/g, " ").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

/** Said plainly, so a missing summary is never mistaken for a real one. */
export function factLine(toolCalls: number): string {
  return toolCalls === 0
    ? "No summary from the judge. No tools ran this round."
    : `No summary from the judge. ${toolCalls} tool ${toolCalls === 1 ? "call" : "calls"} ran this round.`
}

export function makeRound(input: {
  n: number
  startedAt: number
  endedAt: number
  toolCalls: number
  outcome: RoundOutcome
  reason?: string
  achieved?: string
}): Round {
  const summary = capText(input.achieved ?? "")
  const ms = Math.max(0, input.endedAt - input.startedAt)
  return {
    n: input.n,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    ms,
    toolCalls: input.toolCalls,
    outcome: input.outcome,
    reason: capText(input.reason ?? ""),
    achieved: summary || factLine(input.toolCalls),
    ...(summary ? {} : { fallback: true }),
  }
}

/** Keep the newest `cap` rounds. The dropped count is the record of what fell off. */
export function pushRound(
  rounds: readonly Round[],
  dropped: number,
  round: Round,
  cap = MAX_ROUNDS,
): { rounds: Round[]; dropped: number } {
  const next = [...rounds.filter((existing) => existing.n !== round.n), round]
  let count = dropped
  while (next.length > cap) {
    next.shift()
    count++
  }
  return { rounds: next, dropped: count }
}

export function totalMs(rounds: readonly Round[]): number {
  return rounds.reduce((sum, round) => sum + round.ms, 0)
}

export function glyph(outcome: RoundOutcome): string {
  switch (outcome) {
    case "done":
      return "✓"
    case "blocked":
      return "✗"
    case "continue":
      return "→"
    default:
      return "⏸"
  }
}

/** One line: number, outcome, time, then the judge's reason. */
export function roundHeader(round: Round): string {
  const reason = round.reason ? `  ${round.reason}` : ""
  return `#${round.n} ${glyph(round.outcome)} ${formatDuration(round.ms)}${reason}`
}

/** Which rounds are expanded. The newest starts open. */
export type Open = ReadonlySet<number>

export function initialOpen(rounds: readonly Round[]): Open {
  const last = rounds[rounds.length - 1]
  return new Set(last ? [last.n] : [])
}

export function toggleOpen(open: Open, n: number): Open {
  const next = new Set(open)
  if (next.has(n)) next.delete(n)
  else next.add(n)
  return next
}

export const expandAll = (rounds: readonly Round[]): Open => new Set(rounds.map((round) => round.n))
export const collapseAll = (): Open => new Set<number>()

/** A titled block of lines, for the help, settings, and rounds windows. */
export type Section = { title: string; lines: string[] }

/** Split text on blank lines and give each block a title. Extra blocks keep the last title. */
export function sectionsFromText(text: string, titles: readonly string[]): Section[] {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+$/, ""))
    .filter((block) => block.trim().length > 0)
  return blocks.map((block, index) => ({
    title: titles[Math.min(index, titles.length - 1)] ?? "",
    lines: block.split("\n"),
  }))
}

/** Append the round for the turn that just settled. `n` matches the turn counter the user sees. */
export function withRound<
  T extends { turns: number; turnStartedAt?: number; rounds?: Round[]; roundsDropped?: number },
>(
  state: T,
  input: { settledAt: number; outcome: RoundOutcome; reason?: string; achieved?: string; toolCalls: number },
): T {
  const round = makeRound({
    n: state.turns + 1,
    // A goal started before rounds were recorded has no start. Report 0, not a guess.
    startedAt: state.turnStartedAt ?? input.settledAt,
    endedAt: input.settledAt,
    toolCalls: input.toolCalls,
    outcome: input.outcome,
    reason: input.reason,
    achieved: input.achieved,
  })
  const pushed = pushRound(state.rounds ?? [], state.roundsDropped ?? 0, round)
  return { ...state, rounds: pushed.rounds, roundsDropped: pushed.dropped }
}

/** The whole history as text, for a client with no window to show it in. */
export function roundsReport(rounds: readonly Round[], dropped = 0): string {
  if (rounds.length === 0) return "No rounds recorded yet."
  const lines = [`${rounds.length} ${rounds.length === 1 ? "round" : "rounds"}, ${formatDuration(totalMs(rounds))} in all`]
  if (dropped > 0) lines.push(`(${dropped} earlier ${dropped === 1 ? "round" : "rounds"} not kept)`)
  for (const round of [...rounds].reverse()) {
    lines.push("", roundHeader(round), `   ${round.achieved}`)
  }
  return lines.join("\n")
}
