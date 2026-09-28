import { realpathSync } from "node:fs"
import { Plugin } from "@opencode/plugin"

/**
 * Persistent goals, modelled on the Ralph loop.
 *
 * `/goal <text>` sets a standing goal for the current session and starts working
 * on it. After each turn a cheap judge model decides whether the goal is done,
 * still in progress, or unachievable. `continue` feeds a continuation prompt
 * straight back into the same session, so the loop runs without the user having
 * to say "keep going".
 *
 * Three independent backstops keep the loop from running forever:
 *   1. the judge returns `blocked` when a goal cannot be concluded as written or
 *      when the agent is visibly going in circles, which pauses the loop;
 *   2. a turn that ran no tools at all is treated as no progress, and a couple
 *      of those in a row pauses the loop even if the judge keeps saying
 *      "continue"; and
 *   3. a hard turn budget pauses the loop even if nothing objects.
 *
 * Commands:
 *   /goal <text>       set or replace the goal, then start the first turn
 *   /goal status       show the goal, its state, and turns used
 *   /goal pause        stop auto-continuation, keep the goal
 *   /goal resume       resume the loop and reset the turn counter
 *   /goal clear        drop the goal
 *
 * A goal can carry a completion contract, which is what makes the judge
 * accurate. Any line starting with a known field prefix is pulled out of the
 * goal text and shown to the judge as part of the bar for "done":
 *
 *   /goal Port auth to JWT
 *   verify: pytest tests/auth passes
 *   constraints: keep the /login response shape unchanged
 *   scope: only services/auth and its tests
 *   stop when: a DB schema migration is required
 */

type Verdict = "done" | "continue" | "blocked"
type Status = "active" | "paused" | "done" | "blocked"

type Contract = {
  outcome?: string
  verification?: string
  constraints?: string
  boundaries?: string
  stopWhen?: string
}

type GoalState = {
  goal: string
  contract: Contract
  status: Status
  turns: number
  maxTurns: number
  stalled: number
  /** Digest of the previous turn's reply, to spot a loop the judge may miss. */
  lastDigest?: string
  repeats: number
  reason?: string
}

type ModelRef = { providerID: string; id: string; variant?: string }

/** Only these prefixes are treated as contract fields, so a goal that merely
 *  contains a colon ("Fix bug: the parser drops commas") is never mangled. */
const FIELDS: Record<string, keyof Contract> = {
  outcome: "outcome",
  verify: "verification",
  "verified by": "verification",
  verification: "verification",
  constraints: "constraints",
  preserve: "constraints",
  boundaries: "boundaries",
  scope: "boundaries",
  "stop when": "stopWhen",
}

const DEFAULT_MAX_TURNS = 20
const DEFAULT_STALL_LIMIT = 2

/** Small stable digest, so the repeat check does not store whole replies. */
function digest(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 + code + i, 0x85ebca6b) >>> 0
  }
  return `${h1.toString(36)}.${h2.toString(36)}.${text.length}`
}

/** Collapse whitespace and case so trivial reformatting still counts as a repeat. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

/** Split raw command text into a goal headline and its completion contract. */
function parseGoal(raw: string): { goal: string; contract: Contract } {
  const headline: string[] = []
  const contract: Contract = {}
  const current: { key: keyof Contract; lines: string[] }[] = []

  for (const line of raw.split("\n")) {
    const match = /^([a-z][a-z ]*):\s*(.*)$/i.exec(line.trim())
    const key = match ? FIELDS[match[1].trim().toLowerCase()] : undefined
    if (key && match![2].trim()) {
      current.push({ key, lines: [match![2].trim()] })
      continue
    }
    if (current.length && line.trim()) {
      current[current.length - 1].lines.push(line.trim())
      continue
    }
    current.length = 0
    if (line.trim()) headline.push(line.trim())
  }

  for (const entry of current) {
    contract[entry.key] = [...(contract[entry.key] ? [contract[entry.key]!] : []), ...entry.lines].join(" ")
  }

  return { goal: headline.join(" "), contract }
}

function renderContract(contract: Contract): string {
  const lines: string[] = []
  if (contract.outcome) lines.push(`- Outcome: ${contract.outcome}`)
  if (contract.verification) lines.push(`- Proof it is done: ${contract.verification}`)
  if (contract.constraints) lines.push(`- Must not change: ${contract.constraints}`)
  if (contract.boundaries) lines.push(`- In scope: ${contract.boundaries}`)
  if (contract.stopWhen) lines.push(`- Stop and ask when: ${contract.stopWhen}`)
  return lines.length ? `\n\n${lines.join("\n")}` : ""
}

const JUDGE_PROMPT = `You are a strict completion judge for an autonomous coding agent. You do not do the work and you never give advice. Your only job is to classify the state of a standing goal after one turn.

<goal>
{{GOAL}}
</goal>{{CONTRACT}}

<loop state>
Turn {{TURN}} of at most {{MAX_TURNS}} have been spent on this goal.
Tool calls made in the turn you are judging: {{TOOLCALLS}}
Consecutive turns that changed nothing at all: {{STALLED}}
Your verdict on the previous turn was: "continue", because: {{PREVIOUS}}
</loop state>

<agent's last response>
{{RESPONSE}}
</agent's last response>

Reply with exactly one line of strict JSON and nothing else:
{"verdict": "done" | "blocked" | "continue", "reason": "<one sentence>"}

Rules:

- "done" ONLY when the response carries concrete evidence the whole goal is satisfied: a command that passed along with its output, files that were actually created or changed, a test suite that is green. A claim, a plan, an intention, or "I will now..." is never done. If the goal's own proof condition is named above, that specific proof must be present.
- "blocked" when the goal cannot be concluded as written. That covers a goal that is impossible, self-contradictory, outside the repository's scope, or dependent on credentials, hardware, or decisions the agent does not have. It also covers a goal asking for something no amount of the agent's work can produce, even when the agent has not admitted that yet.
- "blocked" when the loop is going in circles: this turn repeats the previous turn's promise, edit, or failing command without new information, or the turn changed nothing while earlier turns did not either. Judge the loop state above, not just the prose.
- "continue" when real, non-repeating progress is still possible. Slow is fine. Stalled is not.
- Judge only what is in front of you. Do not assume work happened off-screen.`

function continuationPrompt(state: GoalState, reason: string): string {
  return `↻ [continuing toward your standing goal — turn ${state.turns}/${state.maxTurns}]

Goal: ${state.goal}${renderContract(state.contract)}

Judge's note: ${reason}

The goal is not met yet. Take the next concrete step. Do not repeat a command that just failed or an edit you just made unless something has changed. If the goal cannot be completed as written, say so plainly and name the blocker — that pauses the loop instead of burning the remaining turns.`
}

function statusReport(state: GoalState | undefined): string {
  if (!state) return "No active goal. Set one with /goal <what you want accomplished>."
  const icon = state.status === "active" ? "⊙" : state.status === "done" ? "✓" : "⏸"
  const lines = [
    `${icon} Goal (${state.status}) — ${state.turns}/${state.maxTurns} turns used`,
    `  ${state.goal}`,
  ]
  if (state.reason) lines.push(`  Last judge: ${state.reason}`)
  return lines.join("\n")
}

/** Pull the final assistant text, the model that produced it, and whether the
 *  turn actually touched anything. A turn with no tool calls made no progress
 *  on a goal that requires work, however confident its prose is. */
async function lastAssistantTurn(
  ctx: any,
  sessionID: string,
): Promise<{ text: string; model?: ModelRef; toolCalls: number }> {
  const messages = (await ctx.session.context({ sessionID })) as readonly any[]

  // A turn is every assistant message after the last user or synthetic input.
  // Tool calls usually land in earlier messages of that turn than the final
  // text, so the whole turn has to be scanned — stopping at the last text
  // message would report "0 tool calls" for a turn that plainly used them.
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const type = messages[i]?.type
    if (type === "user" || type === "synthetic") {
      start = i + 1
      break
    }
  }

  let model: ModelRef | undefined
  let toolCalls = 0
  let text = ""
  for (const message of messages.slice(start)) {
    if (message?.type !== "assistant") continue
    model ??= message.model as ModelRef | undefined
    const content = (message.content ?? []) as readonly any[]
    toolCalls += content.filter((part) => part.type === "tool").length
    const said = content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (said) text = said
  }
  return { text, model, toolCalls }
}

function parseVerdict(raw: string): { verdict: Verdict; reason: string } {
  const match = /\{[\s\S]*\}/.exec(raw)
  if (!match) throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`)
  const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string; done?: boolean }
  // The legacy {"done": bool, "reason": string} shape is still accepted.
  if (parsed.done !== undefined && !parsed.verdict) {
    return { verdict: parsed.done ? "done" : "continue", reason: parsed.reason ?? "" }
  }
  if (parsed.verdict !== "done" && parsed.verdict !== "blocked" && parsed.verdict !== "continue") {
    throw new Error(`judge returned an unknown verdict: ${parsed.verdict}`)
  }
  return { verdict: parsed.verdict, reason: parsed.reason ?? "" }
}

export default Plugin.define({
  id: "goal",
  async setup(ctx) {
    const maxTurns = typeof ctx.options.maxTurns === "number" ? ctx.options.maxTurns : DEFAULT_MAX_TURNS
    const stallLimit =
      typeof ctx.options.stallLimit === "number" ? ctx.options.stallLimit : DEFAULT_STALL_LIMIT
    const judgeOverride = ctx.options.judgeModel as ModelRef | undefined
    const judging = new Set<string>()

    const key = (sessionID: string) => `goal:${sessionID}`

    const read = async (sessionID: string) =>
      (await ctx.storage.get(key(sessionID))) as GoalState | undefined

    const write = async (sessionID: string, state: GoalState | undefined) => {
      if (state) await ctx.storage.set(key(sessionID), state as any)
      else await ctx.storage.remove(key(sessionID))
    }

    /**
     * A global plugin is instantiated once per location, and every instance sees
     * the whole event stream, so one settled turn reaches each of them. If they
     * all acted, each would judge the turn and queue its own continuation.
     *
     * Exactly one instance owns a session: the one loaded for that session's
     * directory. That is decided locally, with no cross-instance messaging, so
     * it cannot race. The storage claim below only covers events that carry no
     * location at all.
     */
    const instanceID = `${ctx.location.directory}:${Math.random().toString(36).slice(2)}`
    const canonical = (path: string) => {
      const trimmed = path.replace(/\/+$/, "")
      try {
        return realpathSync.native(trimmed)
      } catch {
        return trimmed
      }
    }
    const ownedDirectories = new Set(
      [ctx.location.directory, ctx.location.project?.directory, ctx.location.project?.canonical]
        .map((value) => (value === undefined ? undefined : String(value)))
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map(canonical),
    )
    /** `false` = another instance owns it, `true` = ours, `undefined` = unknown. */
    const ownsEvent = (event: { location?: { directory?: string } }) => {
      const directory = event.location?.directory
      if (!directory) return undefined
      return ownedDirectories.has(canonical(directory))
    }

    const claim = async (eventID: string): Promise<boolean> => {
      const claimKey = `claim:${eventID}`
      if (await ctx.storage.get(claimKey)) return false
      await ctx.storage.set(claimKey, { instanceID, at: Date.now() })
      await new Promise((resolve) => setTimeout(resolve, 60))
      const confirmed = (await ctx.storage.get(claimKey)) as { instanceID?: string } | undefined
      return confirmed?.instanceID === instanceID
    }

    /** Drop claims old enough that their event can no longer be redelivered. */
    const pruneClaims = async () => {
      const cutoff = Date.now() - 60 * 60 * 1000
      let page = await ctx.storage.scan({ prefix: "claim:", limit: 200 })
      while (page.entries.length) {
        for (const entry of page.entries) {
          const value = entry.value as { at?: number } | undefined
          if (typeof value?.at === "number" && value.at < cutoff) {
            await ctx.storage.remove(`claim:${entry.key}`)
          }
        }
        if (!page.next) break
        page = await ctx.storage.scan({ prefix: "claim:", limit: 200, after: page.next })
      }
    }

    /**
     * Report to the user. Note that a synthetic inbox message is a real prompt:
     * it starts an execution and costs a model call. So this is only for
     * terminal states and for subcommands the user typed, never per iteration.
     */
    const note = (sessionID: string, text: string) => ctx.session.synthetic({ sessionID, text })
    const terminal = (sessionID: string, text: string) =>
      note(sessionID, `${text}\n\n(The goal loop has stopped. Do not start new work; reply in one short sentence.)`)

    const resolveJudgeModel = async (sessionID: string): Promise<ModelRef> => {
      if (judgeOverride) return judgeOverride
      const { model } = await lastAssistantTurn(ctx, sessionID)
      if (model) return model
      const fallback = await ctx.model.default()
      if (fallback) return fallback as unknown as ModelRef
      throw new Error("no model available to judge with")
    }

    const judge = async (sessionID: string, state: GoalState) => {
      const { text, model, toolCalls } = await lastAssistantTurn(ctx, sessionID)
      const chosen = judgeOverride ?? model ?? (await resolveJudgeModel(sessionID))
      const prompt = JUDGE_PROMPT.replace("{{GOAL}}", state.goal)
        .replace("{{CONTRACT}}", renderContract(state.contract))
        .replace("{{TURN}}", String(state.turns + 1))
        .replace("{{MAX_TURNS}}", String(state.maxTurns))
        .replace("{{TOOLCALLS}}", String(toolCalls))
        .replace("{{STALLED}}", String(state.stalled ?? 0))
        .replace("{{PREVIOUS}}", state.reason || "(this is the first turn)")
        .replace("{{RESPONSE}}", text.slice(-4000) || "(the agent produced no text this turn)")
      const result = await ctx.generate.text({ model: chosen, prompt })
      return parseVerdict(result.text)
    }

    const command = await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "Set a standing goal and keep working until it is done, blocked, or out of turns",
        execute: async ({ sessionID, prompt, delivery }) => {
          // `prompt.text` may or may not still carry the "/goal" prefix.
          const raw = prompt.text.replace(/^\s*\/goal\b/i, "").trim()
          const [head, ...rest] = raw.split(/\s+/)
          const sub = (head ?? "").toLowerCase()
          const argument = rest.join(" ").trim()

          if (!argument && ["pause", "resume", "clear", "status"].includes(sub)) {
            const state = await read(sessionID)
            if (sub === "status") {
              await note(sessionID, statusReport(state))
              return
            }
            if (sub === "pause") {
              if (!state) {
                await note(sessionID, statusReport(undefined))
                return
              }
              await write(sessionID, { ...state, status: "paused", reason: "paused by the user" })
              await note(sessionID, `⏸ Goal paused — ${state.turns}/${state.maxTurns} turns used.`)
              return
            }
            if (sub === "resume") {
              if (!state) {
                await note(sessionID, statusReport(undefined))
                return
              }
              if (state.status === "active") {
                await note(sessionID, statusReport(state))
                return
              }
              const resumed: GoalState = {
                ...state,
                status: "active",
                turns: 0,
                stalled: 0,
                repeats: 0,
                lastDigest: undefined,
                reason: undefined,
              }
              await write(sessionID, resumed)
              await ctx.session.prompt({
                sessionID,
                text: continuationPrompt({ ...resumed, turns: 1 }, "resumed by the user"),
              })
              return
            }
            await write(sessionID, undefined)
            await note(sessionID, "Goal cleared.")
            return
          }

          if (!raw) {
            await note(sessionID, statusReport(await read(sessionID)))
            return
          }

          const { goal, contract } = parseGoal(raw)
          if (!goal) {
            await note(sessionID, "That goal had no objective text. Try: /goal <what you want accomplished>")
            return
          }

          const state: GoalState = {
            goal,
            contract,
            status: "active",
            turns: 0,
            maxTurns,
            stalled: 0,
            repeats: 0,
            lastDigest: undefined,
            reason: undefined,
          }
          await write(sessionID, state)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text:
              `⊙ [goal set — keep working until this is done, or until it is judged unachievable, ` +
              `judged stalled, or out of turns (max ${maxTurns})]\n\n` +
              `Goal: ${goal}${renderContract(contract)}`,
            delivery,
          })
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (
          event.type !== "session.execution.succeeded" &&
          event.type !== "session.execution.failed" &&
          event.type !== "session.execution.interrupted"
        ) {
          continue
        }
        const sessionID = event.data.sessionID
        if (judging.has(sessionID)) continue
        const state = await read(sessionID)
        if (!state || state.status !== "active") continue
        const owned = ownsEvent(event)
        if (owned === false) continue
        if (owned === undefined) {
          if (!(await claim(event.id))) continue
          void pruneClaims().catch(() => {})
        }

        judging.add(sessionID)
        try {
          if (event.type === "session.execution.failed") {
            const reason = `the turn failed: ${event.data.error?.message ?? "unknown error"}`
            await write(sessionID, { ...state, status: "paused", reason })
            await terminal(sessionID, `⏸ Goal paused — ${reason}. Use /goal resume to continue.`)
            continue
          }
          if (event.type === "session.execution.interrupted") {
            await write(sessionID, { ...state, status: "paused", reason: `interrupted (${event.data.reason})` })
            await terminal(sessionID, `⏸ Goal paused — interrupted (${event.data.reason}). Use /goal resume to continue.`)
            continue
          }

          let verdict: { verdict: Verdict; reason: string }
          try {
            verdict = await judge(sessionID, state)
          } catch (error) {
            // Fail open: a broken judge must not wedge the loop. The turn budget
            // is the real backstop.
            verdict = { verdict: "continue", reason: `judge unavailable (${(error as Error).message})` }
          }

          const progressed: GoalState = { ...state, reason: verdict.reason }

          if (verdict.verdict === "done") {
            await write(sessionID, { ...progressed, status: "done" })
            return terminal(sessionID, `✓ Goal achieved: ${verdict.reason || state.goal}`)
          }
          if (verdict.verdict === "blocked") {
            await write(sessionID, { ...progressed, status: "blocked" })
            return terminal(
              sessionID,
              `🚫 Goal judged unachievable — paused: ${verdict.reason}\nRe-scope it with /goal <new text>, or /goal resume to override.`,
            )
          }

          // Two deterministic no-progress checks. These, not the judge, are what
          // actually stop a runaway: a weak judge model will happily answer
          // "continue" to twenty identical replies.
          const { toolCalls, text: replyText } = await lastAssistantTurn(ctx, sessionID)
          const reply = normalize(replyText)
          const repeated = reply.length > 0 && state.lastDigest === digest(reply)
          const repeats = repeated ? (state.repeats ?? 0) + 1 : 0
          const stalled = toolCalls === 0 ? (state.stalled ?? 0) + 1 : 0
          const looping: GoalState = {
            ...progressed,
            lastDigest: reply.length ? digest(reply) : state.lastDigest,
            repeats,
            stalled,
          }

          if (repeats >= 2) {
            await write(sessionID, { ...looping, status: "paused" })
            return terminal(
              sessionID,
              `⏸ Goal paused — looping: the agent has now repeated the same reply ${repeats} turns running without acting. Judge said: ${verdict.reason}\nThe goal is not reachable in this session. Re-scope it with /goal <new text>.`,
            )
          }
          if (stalled >= stallLimit) {
            await write(sessionID, { ...looping, status: "paused" })
            return terminal(
              sessionID,
              `⏸ Goal paused — stalled: ${stalled} turns ran no tools, so nothing changed. Judge said: ${verdict.reason}\nUnblock the cause (missing permission, unavailable tool, wrong directory), then /goal resume.`,
            )
          }

          if (state.turns >= state.maxTurns) {
            await write(sessionID, { ...progressed, status: "paused", stalled })
            return terminal(
              sessionID,
              `⏸ Goal paused — ${state.maxTurns}/${state.maxTurns} turns used. Use /goal resume for another ${state.maxTurns}, or /goal clear to stop.`,
            )
          }

          const next: GoalState = { ...looping, turns: state.turns + 1 }
          await write(sessionID, next)
          // No status message here on purpose: a synthetic inbox message is a
          // real prompt, so it would start another execution, re-enter this
          // loop, and burn the budget twice as fast. The continuation prompt
          // itself already carries the judge's reason.
          await ctx.session.prompt({ sessionID, text: continuationPrompt(next, verdict.reason) })
        } catch (error) {
          const current = await read(sessionID)
          if (current?.status === "active") {
            await write(sessionID, { ...current, status: "paused", reason: (error as Error).message })
            await terminal(sessionID, `⏸ Goal paused — loop error: ${(error as Error).message}`)
          }
        } finally {
          judging.delete(sessionID)
        }
      }
    })()

    return async () => {
      controller.abort()
      await command.dispose()
    }
  },
})
