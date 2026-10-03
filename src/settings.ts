/**
 * Session settings: the turn budget, the stall limit, the polling limit, the
 * quiet flag and the judge model.
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

/**
 * Per-session overrides.
 *
 * `undefined` means "not overridden, use the option". For `maxTurns` the
 * override may also be `null`, which means unlimited - so the two must stay
 * distinct. Using `null` for both made an explicit "unlimited" read back as
 * "not set", and the configured default silently won.
 */
export type Overrides = {
  maxTurns: Budget | undefined
  stall: number | undefined
  poll: number | undefined
  quiet: boolean | undefined
  judge: ModelRef | undefined
}

export const NO_OVERRIDES: Overrides = {
  maxTurns: undefined,
  stall: undefined,
  poll: undefined,
  quiet: undefined,
  judge: undefined,
}

/** What the loop actually uses, after options and overrides are merged. */
export type Effective = {
  maxTurns: Budget
  stall: number
  poll: number
  quiet: boolean
  judge: ModelRef | null
  overridden: { maxTurns: boolean; stall: boolean; poll: boolean; quiet: boolean; judge: boolean }
}

export const DEFAULT_STALL = 2
/** The polling guard waits for three unchanged observations before it pauses. */
export const DEFAULT_POLL = 3

export function resolve(
  options: { maxTurns: Budget; stall: number; poll: number; quiet: boolean; judge: ModelRef | null },
  overrides: Overrides,
): Effective {
  const pick = <T>(override: T | undefined, fallback: T): T =>
    override === undefined ? fallback : override
  return {
    maxTurns: pick(overrides.maxTurns, options.maxTurns),
    stall: pick(overrides.stall, options.stall),
    poll: pick(overrides.poll, options.poll),
    quiet: pick(overrides.quiet, options.quiet),
    judge: pick(overrides.judge, options.judge),
    overridden: {
      maxTurns: overrides.maxTurns !== undefined,
      stall: overrides.stall !== undefined,
      poll: overrides.poll !== undefined,
      quiet: overrides.quiet !== undefined,
      judge: overrides.judge !== undefined,
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

export type SettingKey = "budget" | "stall" | "poll" | "quiet" | "judge"

export const SETTING_KEYS: readonly SettingKey[] = ["budget", "stall", "poll", "quiet", "judge"]

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value)
}

/** The command lines shown under the values, in the window and in the transcript. */
export const SETTING_COMMANDS = [
  "/goal budget <n|unlimited|default>",
  "/goal stall <n|default>",
  "/goal poll <n|default>",
  "/goal quiet <on|off|default>",
  "/goal judge <provider/model[#variant]|default>",
]

export const SETTING_NOTES = [
  "Session overrides last until this session ends. The config default is",
  "whatever maxTurns, stallLimit, pollLimit, quiet and judgeModel are set to in",
  "opencode.json. Panel and display are TUI-only; the rest work anywhere.",
]

const budgetText = (budget: Budget) => (budget === null ? "unlimited" : String(budget))

export type SettingChoice = {
  label: string
  /** The same text a slash command would take. `default` clears the override. */
  argument: string
  current: boolean
}

export type SettingControl = {
  key: SettingKey
  label: string
  value: string
  source: "this session" | "config default"
  hint: string
  /** Free text goes through the host prompt. A plugin dialog receives no keys. */
  editable: boolean
  placeholder: string
  /** What the prompt is prefilled with. Empty when there is nothing to edit. */
  draft: string
  choices: SettingChoice[]
}

export type SettingsForm = {
  intro: string
  controls: SettingControl[]
  commands: string[]
  notes: string[]
}

export type SettingsDefaults = {
  maxTurns: Budget
  stall: number
  poll: number
  quiet: boolean
  judge: ModelRef | null
}

const sourceOf = (overridden: boolean): SettingControl["source"] =>
  overridden ? "this session" : "config default"

const choice = (label: string, argument: string, current = false): SettingChoice => ({
  label,
  argument,
  current,
})

/**
 * The clickable form for `/goal settings`. Choices are the same arguments the slash
 * commands accept, so the window and the command line cannot disagree about what a
 * click means. `default` is offered only when this session has overridden the value.
 */
export function settingsForm(state: Effective, defaults: SettingsDefaults): SettingsForm {
  const budgetChoices: SettingChoice[] = []
  if (typeof state.maxTurns === "number" && state.maxTurns > 1) {
    budgetChoices.push(choice("-", String(state.maxTurns - 1)))
  }
  if (typeof state.maxTurns === "number") {
    budgetChoices.push(choice("+", String(state.maxTurns + 1)))
  }
  for (const preset of [10, 20, 40]) {
    budgetChoices.push(choice(String(preset), String(preset), state.maxTurns === preset))
  }
  budgetChoices.push(choice("unlimited", "unlimited", state.maxTurns === null))
  if (state.overridden.maxTurns) {
    budgetChoices.push(choice(`default (${budgetText(defaults.maxTurns)})`, "default"))
  }

  const countChoices = (current: number, overridden: boolean, fallback: number): SettingChoice[] => {
    const choices: SettingChoice[] = []
    if (current > 1) choices.push(choice("-", String(current - 1)))
    choices.push(choice("+", String(current + 1)))
    if (overridden) choices.push(choice(`default (${fallback})`, "default"))
    return choices
  }

  return {
    intro:
      "Click a control to change it for this session. [type…] opens a prompt, because this window does not take keys.",
    controls: [
      {
        key: "budget",
        label: "Turn budget",
        value: budgetText(state.maxTurns),
        source: sourceOf(state.overridden.maxTurns),
        hint: "Turns before the loop pauses. Unlimited stops only on the judge and the guards.",
        editable: true,
        placeholder: "20, unlimited, or default",
        draft: budgetText(state.maxTurns),
        choices: budgetChoices,
      },
      {
        key: "stall",
        label: "Stall limit",
        value: `${state.stall} turns with no tools`,
        source: sourceOf(state.overridden.stall),
        hint: "Turns with no tool calls before the loop gives up.",
        editable: true,
        placeholder: "a whole number, or default",
        draft: String(state.stall),
        choices: countChoices(state.stall, state.overridden.stall, defaults.stall),
      },
      {
        key: "poll",
        label: "Poll limit",
        value: `${state.poll} unchanged observations`,
        source: sourceOf(state.overridden.poll),
        hint: "Turns re-reading an unchanged result before the loop calls it polling.",
        editable: true,
        placeholder: "a whole number, or default",
        draft: String(state.poll),
        choices: countChoices(state.poll, state.overridden.poll, defaults.poll),
      },
      {
        key: "quiet",
        label: "Quiet mode",
        value: state.quiet ? "on" : "off",
        source: sourceOf(state.overridden.quiet),
        hint: "On: the panel replaces the loop's transcript notices.",
        editable: false,
        placeholder: "on, off, or default",
        draft: state.quiet ? "on" : "off",
        choices: [
          choice("on", "on", state.quiet),
          choice("off", "off", !state.quiet),
          ...(state.overridden.quiet
            ? [choice(`default (${defaults.quiet ? "on" : "off"})`, "default")]
            : []),
        ],
      },
      {
        key: "judge",
        label: "Judge model",
        value: modelLabel(state.judge),
        source: sourceOf(state.overridden.judge),
        hint: "The model that decides done, blocked, or continue.",
        editable: true,
        placeholder: "provider/model or provider/model#variant",
        draft: state.judge ? modelLabel(state.judge) : "",
        choices: state.overridden.judge
          ? [choice(`default (${modelLabel(defaults.judge)})`, "default")]
          : [],
      },
    ],
    commands: [...SETTING_COMMANDS],
    notes: [...SETTING_NOTES],
  }
}

/** The `/goal settings` summary. */
export function renderSettings(state: Effective): string {
  const mark = (overridden: boolean) => (overridden ? "this session" : "config default")
  // budgetLabel lives in budget.ts for the loop's own messages; the same one-line
  // rule is inlined here so this module needs no runtime import of it. The
  // rendered text is pinned in settings.test.ts, so the two cannot drift apart
  // unnoticed.
  return [
    `Turn budget   ${budgetText(state.maxTurns)}   (${mark(state.overridden.maxTurns)})`,
    `Stall limit   ${state.stall} turns with no tools   (${mark(state.overridden.stall)})`,
    `Poll limit    ${state.poll} unchanged observations   (${mark(state.overridden.poll)})`,
    `Quiet mode    ${state.quiet ? "on" : "off"}   (${mark(state.overridden.quiet)})`,
    `Judge model   ${modelLabel(state.judge)}   (${mark(state.overridden.judge)})`,
    ``,
    `Change any of these for this session:`,
    ...SETTING_COMMANDS.map((command) => `  ${command}`),
    ``,
    ...SETTING_NOTES,
  ].join("\n")
}
