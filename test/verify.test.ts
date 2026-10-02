import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  clampTimeout,
  confirmDone,
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_TIMEOUT_MS,
  renderVerifyBlock,
  runVerifyCommand,
  type CommandResult,
} from "../src/verify.ts"
import { OUTPUT_CAP } from "../src/cap.ts"

const passed = (output: string): CommandResult => ({ command: "grep -q passed log", exit: 0, output, timedOut: false })

describe("confirmDone", () => {
  test("a done demotes when the command exits non-zero", async () => {
    let ran = 0
    const out = await confirmDone({
      first: { verdict: "done", reason: "the reply said so" },
      commands: ["grep -q passed log"],
      run: async (command) => {
        ran++
        return { command, exit: 1, output: "not found", timedOut: false }
      },
      judgeAgain: async ({ results }) => {
        assert.equal(results[0].exit, 1)
        return { verdict: "continue", reason: "the re-read failed" }
      },
    })
    assert.equal(ran, 1)
    assert.equal(out.verdict, "continue")
    assert.equal(out.ran, true)
  })

  test("a done stands when the command prints the expected line", async () => {
    const out = await confirmDone({
      first: { verdict: "done", reason: "claimed" },
      commands: ["grep -q passed log"],
      run: async () => passed("passed"),
      judgeAgain: async ({ results }) => {
        assert.match(results[0].output, /passed/)
        return { verdict: "done", reason: "the log says passed" }
      },
    })
    assert.equal(out.verdict, "done")
  })

  test("a continue does not run the command, and cannot be promoted", async () => {
    let ran = 0
    const out = await confirmDone({
      first: { verdict: "continue", reason: "not yet" },
      commands: ["grep -q passed log"],
      run: async (command) => {
        ran++
        return passed(command)
      },
      judgeAgain: async () => ({ verdict: "done", reason: "should not be asked" }),
    })
    assert.equal(ran, 0)
    assert.equal(out.verdict, "continue")
    assert.equal(out.ran, false)
  })

  test("a timeout is attached as a failure", async () => {
    const out = await confirmDone({
      first: { verdict: "done", reason: "claimed" },
      commands: ["tail log"],
      run: async (command) => ({ command, exit: null, output: "", timedOut: true }),
      judgeAgain: async ({ results }) => {
        assert.equal(results[0].timedOut, true)
        assert.match(renderVerifyBlock("done", results), /exit: timeout/)
        return { verdict: "continue", reason: "timed out" }
      },
    })
    assert.equal(out.verdict, "continue")
  })

  test("output longer than the cap is head and tail, with the omitted middle counted", async () => {
    const long = "HEAD" + "x".repeat(OUTPUT_CAP * 3) + "TAIL"
    await confirmDone({
      first: { verdict: "done", reason: "claimed" },
      commands: ["cat log"],
      run: async (command) => ({ command, exit: 0, output: long, timedOut: false }),
      judgeAgain: async ({ results }) => {
        assert.match(results[0].output, /^HEAD/)
        assert.match(results[0].output, /TAIL$/)
        assert.match(results[0].output, /characters omitted/)
        assert.ok(results[0].output.length < long.length)
        return { verdict: "done", reason: "ok" }
      },
    })
  })
})

describe("runVerifyCommand", () => {
  test("passes the command as one argv, in the session directory, with the session environment", async () => {
    const env = { PATH: "/usr/bin" }
    const result = await runVerifyCommand("grep -q passed log", {
      cwd: "/session",
      env,
      timeoutMs: 50,
      execFile: (file, args, options, callback) => {
        assert.equal(file, "/bin/sh")
        assert.deepEqual(args, ["-c", "grep -q passed log"])
        assert.equal(options.cwd, "/session")
        assert.equal(options.env, env)
        assert.equal(options.timeout, 50)
        callback(null, "passed\n", "")
      },
    })
    assert.equal(result.exit, 0)
    assert.equal(result.output, "passed\n")
    assert.equal(result.timedOut, false)
  })

  test("a killed child is a timeout, not a hidden success", async () => {
    const error = Object.assign(new Error("timed out"), { killed: true, code: "ETIMEDOUT" })
    const result = await runVerifyCommand("tail log", {
      cwd: "/session",
      execFile: (_file, _args, _options, callback) => callback(error, "partial", ""),
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.exit, null)
    assert.match(result.output, /partial/)
  })
})

describe("clampTimeout", () => {
  test("defaults to 120s and will not stretch to a gate", () => {
    assert.equal(DEFAULT_VERIFY_TIMEOUT_MS, 120_000)
    assert.equal(clampTimeout(Number.NaN), DEFAULT_VERIFY_TIMEOUT_MS)
    assert.equal(clampTimeout(MAX_VERIFY_TIMEOUT_MS + 60_000), MAX_VERIFY_TIMEOUT_MS)
    assert.ok(MAX_VERIFY_TIMEOUT_MS < 10 * 60_000)
  })
})
