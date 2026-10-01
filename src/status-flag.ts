/**
 * The one thing `/goal status` says that the panel cannot: whether an active goal has ever been
 * judged. A goal left `active` with no verdict reads "running", which looks the same as "busy" —
 * and that is exactly the shape a deaf event loop leaves behind, so it is worth calling out.
 *
 * Kept free of imports so it can be unit-tested directly, like the other pure helpers here.
 */
export type StatusName = "active" | "paused" | "done" | "blocked"

/** True when a goal is active but no turn has ever been judged: "running" that may be stuck. */
export function neverJudged(status: StatusName, turns: number, reason: string | undefined): boolean {
  return status === "active" && turns === 0 && !reason
}

export const NEVER_JUDGED_HINT =
  "  ⚠ Not judged yet — if this stays past a turn, the event loop may be deaf; try /goal resume."
