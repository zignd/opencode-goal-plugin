/**
 * The turn budget, as pure functions.
 *
 * A budget of `null` means unlimited: the loop then stops only when the judge
 * says done or blocked, or when the stall and repetition guards fire. It never
 * stops just for having taken a lot of turns.
 *
 * This lives apart from index.ts so the "is the loop finished?" decision can be
 * tested. That decision is the one backstop standing between a runaway loop and
 * a very large bill, and it used to be a bare `turns >= maxTurns` inline in the
 * event loop.
 */

export type Budget = number | null

export const DEFAULT_BUDGET = 20

const UNLIMITED_WORDS = new Set([
  "unlimited",
  "unbounded",
  "infinite",
  "inf",
  "none",
  "no-limit",
  "nolimit",
])

/** Render a budget for humans: a count, or the word. */
export function budgetLabel(budget: Budget): string {
  return budget === null ? "unlimited" : String(budget)
}

/** The `3/20` form, with an infinity sign when there is no ceiling. */
export function formatTurns(turns: number, budget: Budget): string {
  return `${turns}/${budget === null ? "∞" : budget}`
}

/**
 * Whether the budget is spent. Unlimited budgets never are, which is the whole
 * point of them.
 */
export function isExhausted(turns: number, budget: Budget): boolean {
  return budget !== null && turns >= budget
}

export type ParsedBudget =
  | { kind: "budget"; budget: Budget }
  | { kind: "default" }
  | { kind: "invalid"; value: string }

const VALID = "unlimited, a whole number, or 'default'"

/** Parse what a user typed after `/goal budget`. */
export function parseBudgetArgument(argument: string): ParsedBudget {
  const value = argument.trim().toLowerCase()
  if (!value) return { kind: "invalid", value: "" }
  if (value === "default") return { kind: "default" }
  if (UNLIMITED_WORDS.has(value)) return { kind: "budget", budget: null }
  if (/^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10)
    if (parsed >= 1) return { kind: "budget", budget: parsed }
  }
  return { kind: "invalid", value: argument.trim() }
}

export type ReadBudget = { budget: Budget; warning?: string }

/**
 * Read the `maxTurns` plugin option. A finite count, or `null` / "unlimited" for
 * no ceiling. Anything else falls back to the default and says so, rather than
 * silently starting a goal with a nonsense budget.
 */
export function readBudgetOption(value: unknown, fallback: Budget = DEFAULT_BUDGET): ReadBudget {
  if (value === null || value === "unlimited") return { budget: null }
  if (typeof value === "string" && UNLIMITED_WORDS.has(value.toLowerCase())) {
    return { budget: null }
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 1) return { budget: value }
    return {
      budget: fallback,
      warning: `maxTurns must be a whole number of at least 1, or "unlimited"; got ${value}. Using ${budgetLabel(fallback)}.`,
    }
  }
  if (value === undefined) return { budget: fallback }
  return {
    budget: fallback,
    warning: `maxTurns must be a whole number of at least 1, or "unlimited"; got ${JSON.stringify(value)}. Using ${budgetLabel(fallback)}.`,
  }
}

/** A sentence explaining what an unlimited budget gives up, for the confirmation. */
export const UNLIMITED_CAVEAT = `No turn limit. The loop now stops only when the judge says done or unachievable,
or when it stalls (no tools), repeats itself, or you stop it. There is no
longer a ceiling on cost or wall-clock time.`
