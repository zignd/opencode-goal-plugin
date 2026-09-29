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
export type Choice = Placement | "__off"

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

/**
 * Apply a choice from the picker. Selecting a placement toggles only that one;
 * "__off" is the only choice that turns everything off. Merging those two cases
 * previously left every other placement defaulting to false, so picking one
 * silently switched the rest off.
 */
export function applyChoice(current: Display, choice: Choice): Display {
  if (choice === "__off") return { panel: false, footer: false, composer: false, sidebar: false }
  return { ...current, [choice]: !current[choice] }
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
