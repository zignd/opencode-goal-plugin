/**
 * What the agent and the judge are told.
 *
 * The agent does not read this plugin. A tool is reached because its description
 * says when to call it instead of replying, and because the continuation names it
 * in the matching situation. A description that only says what the tool returns
 * is a failed registration.
 */

import { formatTurns, type Budget } from "./budget.js"
import { renderContract, type Contract } from "./contract.js"

export type ContinuationState = {
  goal: string
  contract: Contract
  turns: number
  maxTurns: Budget
}

export const TOOLS = {
  goal_wait: {
    name: "goal_wait",
    description:
      "While a standing goal is active and a background command or child session you started is still running, " +
      "call this instead of replying with a status update. It returns when that work finishes, or after " +
      "`seconds`, whichever comes first.",
  },
  goal_blocked: {
    name: "goal_blocked",
    description:
      "When a standing goal cannot be completed as written, call this instead of saying so in the reply. " +
      "Naming a blocker in prose does not pause the loop. A non-empty reason is required.",
  },
  goal_pending: {
    name: "goal_pending",
    description:
      "While a standing goal is active, call this instead of guessing which background jobs are still running. " +
      "It returns the unfinished shell and child-session ids, and nothing else.",
  },
  goal_evidence: {
    name: "goal_evidence",
    description:
      "When a command just proved part of the goal's verify: condition, call this instead of leaving the proof " +
      "only in the reply. Filing evidence does not finish the goal.",
  },
} as const

export function continuationPrompt(
  state: ContinuationState,
  reason: string,
  quiet: boolean,
  pending: readonly string[] = [],
): string {
  const banner = quiet
    ? ""
    : `↻ [continuing toward your standing goal — turn ${formatTurns(state.turns, state.maxTurns)}]\n\n`
  const step =
    pending.length > 0
      ? `A worker is still running on this task (${pending.join(", ")}); do not start another on the same files. If there is nothing else to do, call goal_wait instead of replying with a status update.`
      : `The goal is not met yet. Take the next concrete step. Do not repeat a command that just failed or an edit you just made unless something has changed. If a background command you started is still running and there is nothing else to do, call goal_wait instead of replying with a status update. If the goal cannot be completed as written, call goal_blocked with the reason instead of saying so in the reply. If a command just proved a part of verify:, call goal_evidence with the command, the exit code, and the output instead of leaving the proof only in the reply.`
  return `${banner}Goal: ${state.goal}${renderContract(state.contract)}

Judge's note: ${reason}

${step}`
}

export function buildJudgePrompt(input: {
  goal: string
  contract: string
  turn: string
  maxTurns: string
  toolCalls: string
  stalled: string
  observing: string
  previous: string
  response: string
  evidence: string
  verify?: string
}): string {
  const verify = input.verify?.trim() ? `\n\n<verify-cmd>\n${input.verify.trim()}\n</verify-cmd>` : ""
  return `You are a strict completion judge for an autonomous coding agent. You do not do the work and you never give advice. Your only job is to classify the state of a standing goal after one turn.

<goal>
${input.goal}
</goal>${input.contract}

<loop state>
Turn ${input.turn} of at most ${input.maxTurns} have been spent on this goal.
Tool calls made in the turn you are judging: ${input.toolCalls}
Consecutive turns that changed nothing at all: ${input.stalled}
Consecutive turns that repeated one observation without a result changing: ${input.observing}
Your verdict on the previous turn was: "continue", because: ${input.previous}
</loop state>

${input.evidence}${verify}

<agent's last response>
${input.response}
</agent's last response>

Reply with exactly one line of strict JSON and nothing else:
{"verdict": "done" | "blocked" | "continue", "reason": "<one sentence>", "achieved": "<one or two sentences>"}

"achieved" says what THIS turn concretely did: files changed, commands run and what they printed. It is never what remains to be done, and never a restatement of the goal. Leave it "" when the turn did nothing.

Rules:

- "done" ONLY when concrete evidence the whole goal is satisfied is present: a command that passed along with its output, files that were actually created or changed, a test suite that is green. A claim, a plan, an intention, or "I will now..." is never done. If the goal's own proof condition is named above, that specific proof must be present.
- You may say "done" from the digest plus a verify-cmd that just passed, even when the latest reply is only a status sentence. You may not say "done" from the digest alone when no verify-cmd exists: a description in verify: is still prose, and the reply has to carry it.
- "blocked" ONLY when the GOAL cannot be concluded as written: impossible, self-contradictory, outside the repository's scope, or dependent on credentials, hardware, or decisions the agent does not have. It also covers a goal asking for something no amount of the agent's work can produce, even when the agent has not admitted that yet.
- "blocked" requires goal-level evidence. A turn that was unproductive, slow, repeated, or made no change is evidence about THIS TURN, never about whether the goal is reachable. Repetition is recoverable — the next turn can do something different — so repetition alone must never produce "blocked", however many turns it has happened.
- "continue" when real progress is still possible, AND when this turn was unproductive. Slow is fine. Waiting is fine. Stalled is not.
- A turn that checked on work already in flight — a background build, a long test run, a command started earlier — is WAITING, not going in circles, unless the underlying work shows no progress at all across several turns. Do not read a repeated read-only check as a dead goal.
- If the loop state above suggests repetition, the correct verdict is still "continue": say in the reason what the agent should change (do different work, or stop polling and wait for the result), and let the next turn act on it.
- The digest and the pending-id list are the off-screen record. Anything not in the reply, the digest, or that list did not happen.`
}
