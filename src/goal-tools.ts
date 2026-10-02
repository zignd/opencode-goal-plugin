/**
 * The effects of the goal tools, without the host.
 *
 * A registration is not a hint, and a tool call is not a verdict. `goal_blocked`
 * pauses; the next judge pass does not get to reclassify that. `goal_evidence`
 * files proof and does not finish the goal. None of them schedule a continuation.
 */

import { appendEvidence, type EvidenceDigest } from "./evidence.js"

export type ToolEffect<T> = {
  content: string
  state?: T
  /** A tool never schedules a continuation. The loop does that, and only while active. */
  schedule: false
}

type Active = {
  status: string
  reason?: string
  pausedBy?: "tool"
  evidence?: EvidenceDigest
}

export function goalBlocked<T extends Active>(state: T | undefined, reason: unknown): ToolEffect<T> {
  if (!state || state.status !== "active") {
    return { content: "No goal is active, so there is nothing to pause.", schedule: false }
  }
  const text = typeof reason === "string" ? reason.trim() : ""
  if (!text) {
    return {
      content: "goal_blocked needs a non-empty reason. The goal stays active.",
      schedule: false,
    }
  }
  return {
    content: `Goal paused: ${text}`,
    state: { ...state, status: "paused", pausedBy: "tool", reason: text },
    schedule: false,
  }
}

/** A tool pause is the agent using `stop when:`. A later `continue` does not wake it. */
export function heldByTool(state: { status: string; pausedBy?: string } | undefined): boolean {
  return !state || state.status !== "active" || state.pausedBy === "tool"
}

export function goalPending<T extends { status: string }>(
  state: T | undefined,
  ids: readonly string[],
): ToolEffect<T> {
  if (!state || state.status !== "active") {
    return { content: "No goal is active, so nothing is pending.", schedule: false }
  }
  if (ids.length === 0) return { content: "Nothing is pending.", schedule: false }
  return { content: ids.join("\n"), schedule: false }
}

export function goalEvidence<T extends Active>(
  state: T | undefined,
  input: { command?: unknown; exit?: unknown; output?: unknown },
  cap?: number,
): ToolEffect<T> {
  if (!state || state.status !== "active") {
    return { content: "No goal is active, so there is nowhere to file evidence.", schedule: false }
  }
  if (!state.evidence) {
    throw new Error("goal_evidence: no digest exists yet")
  }
  const command = typeof input.command === "string" ? input.command.trim() : ""
  if (!command) {
    return { content: "goal_evidence needs a command. Nothing was filed.", schedule: false }
  }
  const exit = typeof input.exit === "number" && Number.isFinite(input.exit) ? input.exit : null
  if (exit === null) {
    return { content: "goal_evidence needs an exit code. Nothing was filed.", schedule: false }
  }
  const output = typeof input.output === "string" ? input.output : ""
  return {
    content: `Filed: ${command} (exit ${exit}). This does not finish the goal.`,
    state: {
      ...state,
      status: state.status,
      evidence: appendEvidence(state.evidence, { command, exit, output }, cap),
    },
    schedule: false,
  }
}
