/**
 * Where the goal is shown, as pure functions.
 *
 * This lives apart from tui.tsx on purpose: the picker logic had a bug that only
 * showed up when a person clicked through the dialog, which is not something an
 * automated check can do. Keeping it here, with no JSX and no Solid, means it can
 * be exercised directly.
 */

export const PLACEMENTS = ["panel", "footer", "composer", "sidebar"] as const
export type Placement = (typeof PLACEMENTS)[number]
export type Display = Record<Placement, boolean>

export const DEFAULTS: Display = { panel: true, footer: true, composer: false, sidebar: false }

/** Options override the defaults, key by key; anything unmentioned keeps its default. */
export function seedDisplay(given: unknown): Display {
  const source = (given ?? {}) as Partial<Record<Placement, unknown>>
  const next = { ...DEFAULTS }
  for (const key of PLACEMENTS) {
    if (typeof source[key] === "boolean") next[key] = source[key] as boolean
  }
  return next
}

export const isPlacement = (value: string): value is Placement =>
  (PLACEMENTS as readonly string[]).includes(value)

const TRUTHY = /^(on|true|yes|1)$/i
const FALSY = /^(off|false|no|0)$/i

export type ParsedDisplay = {
  /** Placements named on the command line, in order, deduplicated. */
  placements: Placement[]
  /** Explicit on/off if given, otherwise undefined meaning "toggle". */
  enabled?: boolean
  /** Anything the user typed that is not a placement, for the error message. */
  unknown: string[]
}

/**
 * Parse `/goal display <where>... [on|off]`. Accepts a comma or space separated
 * list so several can be set at once, which is the whole point: a picker that
 * closes on the first click would need reopening per change.
 */
export function parseDisplayArgument(argument: string): ParsedDisplay {
  const tokens = argument
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean)
  const placements: Placement[] = []
  const unknown: string[] = []
  let enabled: boolean | undefined

  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (TRUTHY.test(lower)) {
      enabled = true
      continue
    }
    if (FALSY.test(lower)) {
      enabled = false
      continue
    }
    if (isPlacement(lower)) {
      if (!placements.includes(lower)) placements.push(lower)
    } else {
      unknown.push(token)
    }
  }
  return { placements, ...(enabled === undefined ? {} : { enabled }), unknown }
}

/**
 * Apply a parsed command. With an explicit on/off the named placements are set
 * and the rest are untouched; without one, each named placement is toggled.
 */
export function applyParsed(current: Display, parsed: ParsedDisplay): Display {
  let next = current
  for (const key of parsed.placements) {
    next = applySet(next, key, parsed.enabled ?? !next[key])
  }
  return next
}

/** Set one placement explicitly, leaving the rest alone. */
export function applySet(current: Display, placement: Placement, enabled: boolean): Display {
  return { ...current, [placement]: enabled }
}

/** Human-readable summary, for the toast. */
export function describe(current: Display): string {
  const on = PLACEMENTS.filter((key) => current[key])
  return on.length ? on.join(", ") : "hidden everywhere"
}

/** Set every placement at once — the "hide everywhere" case in the picker. */
export function applyAll(enabled: boolean): Display {
  return { panel: enabled, footer: enabled, composer: enabled, sidebar: enabled }
}

