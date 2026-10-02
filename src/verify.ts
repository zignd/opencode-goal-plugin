/**
 * `verify-cmd` re-reads an artifact. It does not re-run the proof.
 *
 * A five-gate takes about ten minutes and holds a lock. The judge running it again
 * races the agent. The field is a cheap check of a log the agent already wrote.
 * The default timeout is enough for that re-read and too short for a gate.
 */

import { execFile as execFileCb } from "node:child_process"
import { capText } from "./cap.js"

export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
/** Above the default, below a five-gate. A command that needs longer is the wrong command. */
export const MAX_VERIFY_TIMEOUT_MS = 300_000

export type Verdict = "done" | "continue" | "blocked"

export type CommandResult = {
  command: string
  exit: number | null
  output: string
  timedOut: boolean
}

export function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_VERIFY_TIMEOUT_MS
  return Math.min(Math.max(1, Math.floor(ms)), MAX_VERIFY_TIMEOUT_MS)
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
  callback: (error: (NodeJS.ErrnoException & { killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => void

/**
 * One command string, passed as the shell's `-c` argument and not concatenated
 * with plugin text. `cwd` is the session directory. `env` is the session environment.
 */
export function runVerifyCommand(
  command: string,
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    execFile?: ExecFile
  },
): Promise<CommandResult> {
  const timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS)
  const exec = options.execFile ?? (execFileCb as unknown as ExecFile)
  return new Promise((resolve) => {
    exec(
      "/bin/sh",
      ["-c", command],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const out = stdout ?? ""
        const err = stderr ?? ""
        const output = capText(out && err ? `${out}\n${err}` : out || err)
        const timedOut = Boolean(error && (error.killed || error.code === "ETIMEDOUT"))
        const code = error ? error.code : 0
        const exit = timedOut ? null : typeof code === "number" ? code : 1
        resolve({ command, exit, output, timedOut })
      },
    )
  })
}

export function renderVerifyBlock(first: Verdict, results: readonly CommandResult[]): string {
  const lines = [`First verdict: ${first}`]
  for (const result of results) {
    const exit = result.timedOut ? "timeout" : String(result.exit)
    lines.push(`$ ${result.command}`, `exit: ${exit}`, result.output)
  }
  return lines.join("\n")
}

/**
 * Run the commands only after a first-pass `done`, then judge again with the output
 * attached. The second pass may demote `done`. It must not promote a `continue`.
 */
export async function confirmDone(options: {
  first: { verdict: Verdict; reason: string }
  commands: readonly string[]
  run: (command: string) => Promise<CommandResult>
  judgeAgain: (input: {
    first: Verdict
    results: CommandResult[]
  }) => Promise<{ verdict: Verdict; reason: string }>
}): Promise<{ verdict: Verdict; reason: string; results: CommandResult[]; ran: boolean }> {
  if (options.first.verdict !== "done" || options.commands.length === 0) {
    return { verdict: options.first.verdict, reason: options.first.reason, results: [], ran: false }
  }
  const results: CommandResult[] = []
  for (const command of options.commands) {
    const result = await options.run(command)
    results.push({ ...result, output: capText(result.output) })
  }
  const second = await options.judgeAgain({ first: "done", results })
  if (second.verdict === "done") {
    return { verdict: "done", reason: second.reason, results, ran: true }
  }
  return { verdict: second.verdict, reason: second.reason, results, ran: true }
}
