/**
 * Session settings: the turn budget, the stall limit, the quiet flag and the
 * judge model.
 *
 * Each has a value in the plugin options, which is the default, and may be
 * overridden for one session with a `/goal …` subcommand. Pure functions only,
 * so parsing and the summary text can be tested without a terminal — the same
 * reasoning as display.ts and budget.ts.
 *
 * "Unset" and "set to the default" both mean *use the configured value*, so an
 * override that has been cleared and one that was never made are the same thing.
 */

// Type-only, so it is erased and no runtime import of budget.js is needed: the
// plugin source uses .js specifiers for OpenCode's loader, while the checks in
// settings.test.ts run under plain node, which only resolves .ts specifiers.
import type { Budget } from "./budget.js"

export type ModelRef = { providerID: string; id: string; variant?: string }

/** Per-session overrides. `null` means "not overridden, use the option". */
export type Overrides = {
  maxTurns: Budget | null
  stall: number | null
  quiet: boolean | null
  judge: ModelRef | null
}

export const NO_OVERRIDES: Overrides = {
  maxTurns: null,
  stall: null,
  quiet: null,
  judge: null,
}

/** What the loop actually uses, after options and overrides are merged. */
export type Effective = {
  maxTurns: Budget
  stall: number
  quiet: boolean
  judge: ModelRef | null
  overridden: { maxTurns: boolean; stall: boolean; quiet: boolean; judge: boolean }
}

export const DEFAULT_STALL = 2

export function resolve(
  options: { maxTurns: Budget; stall: number; quiet: boolean; judge: ModelRef | null },
  overrides: Overrides,
): Effective {
  const pick = <T>(override: T | null, fallback: T): T => (override === null ? fallback : override)
  return {
    maxTurns: pick(overrides.maxTurns, options.maxTurns),
    stall: pick(overrides.stall, options.stall),
    quiet: pick(overrides.quiet, options.quiet),
    judge: pick(overrides.judge, options.judge),
    overridden: {
      maxTurns: overrides.maxTurns !== null,
      stall: overrides.stall !== null,
      quiet: overrides.quiet !== null,
      judge: overrides.judge !== null,
    },
  }
}

export type Parsed<T> =
  | { kind: "value"; value: T }
  | { kind: "clear" }
  | { kind: "invalid" }

const TRUTHY = new Set(["on", "true", "yes", "1", "enable", "enabled"])
const FALSY = new Set(["off", "false", "no", "0", "disable", "disabled"])
const CLEAR = new Set(["default", "reset", "unset", "clear", "none", "off", "auto"])

/** Parse a whole number of at least 1, or `default`. Used by stall. */
export function parseCount(argument: string, label: string): Parsed<number> {
  const value = argument.trim().toLowerCase()
  if (!value) return { kind: "invalid" }
  if (CLEAR.has(value)) return { kind: "clear" }
  if (/^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10)
    if (parsed >= 1) return { kind: "value", value: parsed }
  }
  return { kind: "invalid" }
}

/** Parse on/off, or `default`. */
export function parseFlag(argument: string): Parsed<boolean> {
  const value = argument.trim().toLowerCase()
  if (!value) return { kind: "invalid" }
  if (value === "default" || value === "reset" || value === "unset") return { kind: "clear" }
  if (TRUTHY.has(value)) return { kind: "value", value: true }
  if (FALSY.has(value)) return { kind: "value", value: false }
  return { kind: "invalid" }
}

/**
 * Parse a judge model as `provider/model` or `provider/model#variant`.
 * `default` clears it, which falls back to the model the session is using.
 */
export function parseModel(argument: string): Parsed<ModelRef | null> {
  const value = argument.trim()
  if (!value) return { kind: "invalid" }
  const lower = value.toLowerCase()
  if (CLEAR.has(lower) || lower === "session") return { kind: "clear" }
  const [path, variant] = value.split("#")
  // Split on the first slash only. Model ids very often contain slashes
  // themselves — `openrouter/google/gemini-3-flash-preview`,
  // `openrouter/perceptron/perceptron-mk1.5` — so rejecting a second slash
  // would refuse most real model references.
  const slash = path.indexOf("/")
  if (slash <= 0 || slash === path.length - 1) return { kind: "invalid" }
  return {
    kind: "value",
    value: {
      providerID: path.slice(0, slash),
      id: path.slice(slash + 1),
      ...(variant ? { variant } : {}),
    },
  }
}

export function modelLabel(model: ModelRef | null): string {
  if (!model) return "the session's model"
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

/** The `/goal settings` summary. */
export function renderSettings(state: Effective): string {
  const mark = (overridden: boolean) => (overridden ? "this session" : "config default")
  // budgetLabel lives in budget.ts for the loop's own messages; the same one-line
  // rule is inlined here so this module needs no runtime import of it. The
  // rendered text is pinned in settings.test.ts, so the two cannot drift apart
  // unnoticed.
  const budgetText = state.maxTurns === null ? "unlimited" : String(state.maxTurns)
  return [
    `Turn budget   ${budgetText}   (${mark(state.overridden.maxTurns)})`,
    `Stall limit   ${state.stall} turns with no tools   (${mark(state.overridden.stall)})`,
    `Quiet mode    ${state.quiet ? "on" : "off"}   (${mark(state.overridden.quiet)})`,
    `Judge model   ${modelLabel(state.judge)}   (${mark(state.overridden.judge)})`,
    ``,
    `Change any of these for this session:`,
    `  /goal budget <n|unlimited|default>`,
    `  /goal stall <n|default>`,
    `  /goal quiet <on|off|default>`,
    `  /goal judge <provider/model[#variant]|default>`,
    ``,
    `Session overrides last until this session ends. The config default is`,
    `whatever maxTurns, stallLimit, quiet and judgeModel are set to in`,
    `opencode.json. Panel and display are TUI-only; the rest work anywhere.`,
  ].join("\n")
}
