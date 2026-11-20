/**
 * Subgoals: acceptance criteria the user adds while a goal is running.
 *
 * A goal is one objective plus a contract. A subgoal is a numbered criterion
 * appended mid-loop, and every one of them has to be met before the goal is
 * done. They are persisted inside the goal state, so a resume keeps them and a
 * new `/goal` or `/goal clear` drops them with the goal.
 *
 * The judge reports which criteria are met each turn. That is what turns the
 * list into a progress ratio, and it is also the deterministic guard against a
 * judge that says `done` while a criterion is still open.
 *
 * Pure and host-free: the server, the prompt builder and the tests share it.
 */

import { capText } from "./rounds.js"
import type { Progress } from "./progress.js"

export const MAX_SUBGOAL = 500

export type Subgoal = {
  /** One line. Whitespace is collapsed by `addSubgoal`. */
  text: string
  /** Whether the judge has reported this criterion as satisfied. */
  met: boolean
}

export type ParsedSubgoal =
  | { kind: "list" }
  | { kind: "clear" }
  | { kind: "remove"; n: number }
  | { kind: "add"; text: string }
  | { kind: "invalid"; reason: string }

/**
 * `/subgoal <text>` appends, `/subgoal` lists, `/subgoal remove <n>` removes,
 * `/subgoal clear` drops the list.
 *
 * Only an exact `clear` clears, and only `remove <digits>` removes, so a
 * criterion that happens to start with those words ("clear the cache",
 * "remove the legacy path") is still addable.
 */
export function parseSubgoalArgument(argument: string): ParsedSubgoal {
  const text = argument.trim()
  if (!text) return { kind: "list" }

  const lower = text.toLowerCase()
  if (lower === "clear") return { kind: "clear" }
  if (lower === "remove") {
    return {
      kind: "invalid",
      reason: "Give the number of the subgoal to remove, 1-based. Example: /subgoal remove 2.",
    }
  }

  const remove = /^remove\s+(\d+)$/i.exec(text)
  if (remove) {
    const n = Number.parseInt(remove[1], 10)
    if (n < 1) {
      return {
        kind: "invalid",
        reason: "Subgoals are numbered from 1. Example: /subgoal remove 2.",
      }
    }
    return { kind: "remove", n }
  }

  return { kind: "add", text }
}

/** Append a criterion. Returns a new list; the caller decides whether to write it. */
export function addSubgoal(subgoals: readonly Subgoal[] | undefined, raw: string): Subgoal[] {
  const text = capText(raw, MAX_SUBGOAL)
  return [...(subgoals ?? []), { text, met: false }]
}

export type RemoveResult =
  | { ok: true; subgoals: Subgoal[]; removed: Subgoal }
  | { ok: false; reason: string }

/** Remove the nth criterion, 1-based. The rest renumber by position. */
export function removeSubgoal(subgoals: readonly Subgoal[] | undefined, n: number): RemoveResult {
  const list = subgoals ?? []
  if (list.length === 0) return { ok: false, reason: "There are no subgoals to remove." }
  if (!Number.isInteger(n) || n < 1 || n > list.length) {
    return {
      ok: false,
      reason: `There is no subgoal #${n}. There ${list.length === 1 ? "is 1 subgoal" : `are ${list.length} subgoals`}.`,
    }
  }
  const removed = list[n - 1]
  return { ok: true, subgoals: list.filter((_, index) => index !== n - 1), removed }
}

/** Mark exactly the listed 1-based indices as met. Out-of-range values are ignored. */
export function applyMet(subgoals: readonly Subgoal[], met: readonly number[]): Subgoal[] {
  const set = new Set(
    met.filter((n) => Number.isInteger(n) && n >= 1 && n <= subgoals.length),
  )
  return subgoals.map((subgoal, index) => ({ ...subgoal, met: set.has(index + 1) }))
}

export function subgoalProgress(subgoals: readonly Subgoal[] | undefined): Progress | undefined {
  if (!subgoals || subgoals.length === 0) return undefined
  return {
    done: subgoals.filter((subgoal) => subgoal.met).length,
    total: subgoals.length,
    source: "subgoals",
  }
}

export function allSubgoalsMet(subgoals: readonly Subgoal[] | undefined): boolean {
  return !subgoals || subgoals.every((subgoal) => subgoal.met)
}

/**
 * Reconcile the list the judge worked from with the list in storage now.
 *
 * The user can add or remove a criterion while the judge is running. In that
 * window the judged list is stale, and writing it back would drop the change.
 * When the texts differ, the stored list wins and met marks are carried over by
 * text; a criterion the judge never saw stays unmet until the next turn.
 */
export function mergeSubgoals(
  current: readonly Subgoal[] | undefined,
  judged: readonly Subgoal[] | undefined,
): Subgoal[] | undefined {
  if (!current) return judged?.map((subgoal) => ({ ...subgoal }))
  if (!judged) return current.map((subgoal) => ({ ...subgoal }))
  const same =
    current.length === judged.length && current.every((subgoal, index) => subgoal.text === judged[index].text)
  if (same) return judged.map((subgoal) => ({ ...subgoal }))
  const met = new Map(judged.map((subgoal) => [subgoal.text, subgoal.met]))
  return current.map((subgoal) => ({ ...subgoal, met: met.get(subgoal.text) ?? subgoal.met }))
}

export type Judged = {
  verdict: "done" | "continue" | "blocked"
  reason: string
  achieved?: string
  /** 1-based numbers of subgoals the judge says are now met. */
  met?: number[]
}

/**
 * Reconcile a judge verdict with the subgoal list.
 *
 * A `done` verdict is a claim about the whole goal. When the judge supplies a
 * partial `met` list with it, the two contradict each other, so the verdict is
 * demoted to `continue` deterministically rather than trusting the weaker half.
 * A `done` with no `met` list is taken at face value and marks every criterion
 * met. A `continue` or `blocked` with a `met` list updates the list exactly, so
 * progress can move in both directions.
 */
export function applySubgoalVerdict(
  subgoals: readonly Subgoal[] | undefined,
  verdict: Judged,
): { verdict: Judged; subgoals: Subgoal[] | undefined } {
  if (!subgoals || subgoals.length === 0) {
    return { verdict, subgoals: subgoals ? subgoals.map((subgoal) => ({ ...subgoal })) : undefined }
  }

  const provided = verdict.met !== undefined
  if (verdict.verdict === "done") {
    if (provided) {
      const next = applyMet(subgoals, verdict.met!)
      const missing = next.findIndex((subgoal) => !subgoal.met)
      if (missing >= 0) {
        return {
          verdict: {
            ...verdict,
            verdict: "continue",
            reason: `subgoal ${missing + 1} is not met yet: ${next[missing].text}${verdict.reason ? ` — ${verdict.reason}` : ""}`,
          },
          subgoals: next,
        }
      }
      return { verdict, subgoals: next }
    }
    return {
      verdict,
      subgoals: subgoals.map((subgoal) => ({ ...subgoal, met: true })),
    }
  }

  return {
    verdict,
    subgoals: provided ? applyMet(subgoals, verdict.met!) : subgoals.map((subgoal) => ({ ...subgoal })),
  }
}

/** `1. [x] text` per line. The brackets are a checklist, not decoration. */
export function renderSubgoalList(subgoals: readonly Subgoal[] | undefined): string {
  if (!subgoals || subgoals.length === 0) return "No subgoals."
  return subgoals.map((subgoal, index) => `${index + 1}. [${subgoal.met ? "x" : " "}] ${subgoal.text}`).join("\n")
}

/** The block the agent sees on every continuation while criteria are open. */
export function renderSubgoalBlock(subgoals: readonly Subgoal[] | undefined): string {
  if (!subgoals || subgoals.length === 0) return ""
  return (
    `\n\nAdditional criteria the user added mid-goal (all must be met before the goal is done):\n` +
    renderSubgoalList(subgoals)
  )
}

/**
 * The block the judge sees. It deliberately omits the met marks: the judge has
 * to decide what is met from this turn's evidence, not copy last turn's answer.
 */
export function renderSubgoalCriteria(subgoals: readonly Subgoal[] | undefined): string {
  if (!subgoals || subgoals.length === 0) return ""
  return (
    `\n\n<additional criteria>\n` +
    `The user added these while the goal was running. Every one is part of the goal.\n` +
    subgoals.map((subgoal, index) => `${index + 1}. ${subgoal.text}`).join("\n") +
    `\n</additional criteria>`
  )
}

/** A transcript summary for `/subgoal` with no argument. */
export function subgoalReport(subgoals: readonly Subgoal[] | undefined): string {
  const progress = subgoalProgress(subgoals)
  if (!progress) return "No subgoals. Add one with /subgoal <text>."
  return `Subgoals ${progress.done}/${progress.total} met (${Math.round((progress.done / progress.total) * 100)}%):\n${renderSubgoalList(subgoals)}`
}
