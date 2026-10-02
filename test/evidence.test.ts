import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { appendEvidence, emptyDigest, renderEvidence, withPending } from "../src/evidence.ts"
import { buildJudgePrompt } from "../src/prompt.ts"
import { capText, OUTPUT_CAP } from "../src/cap.ts"

describe("renderEvidence", () => {
  test("an empty digest renders the explicit empty line", () => {
    assert.match(renderEvidence(undefined), /No proof has been recorded yet/)
    assert.match(renderEvidence(emptyDigest()), /No proof has been recorded yet/)
  })

  test("pending ids appear, and disappear once the completion notice has cleared them", () => {
    const withIds = withPending(emptyDigest(), ["sh_one", "ses_two"])
    assert.match(renderEvidence(withIds), /Still pending: sh_one, ses_two/)
    const cleared = withPending(withIds, [])
    assert.doesNotMatch(renderEvidence(cleared), /sh_one/)
    assert.match(renderEvidence(cleared), /No proof has been recorded yet/)
  })

  test("a later reply that does not quote the log still presents the earlier command output", () => {
    const first = appendEvidence(emptyDigest(), {
      command: "grep -q passed build/five-gate.log",
      exit: 0,
      output: "passed",
    })
    const prompt = buildJudgePrompt({
      goal: "close phase 20",
      contract: "",
      turn: "2",
      maxTurns: "20",
      toolCalls: "0",
      stalled: "0",
      observing: "0",
      previous: "waiting",
      response: "still waiting",
      evidence: renderEvidence(first),
    })
    assert.match(prompt, /grep -q passed build\/five-gate\.log/)
    assert.match(prompt, /passed/)
    assert.match(prompt, /still waiting/)
    assert.match(prompt, /digest and the pending-id list are the off-screen record/)
    assert.doesNotMatch(prompt, /do not assume work did NOT happen/)
  })
})

describe("capText", () => {
  test("keeps a head and a tail, and says how much was omitted", () => {
    const text = "PROOF" + "m".repeat(OUTPUT_CAP * 3) + "STATUS"
    const capped = capText(text)
    assert.match(capped, /^PROOF/)
    assert.match(capped, /STATUS$/)
    assert.match(capped, /characters omitted/)
    assert.ok(!capped.endsWith(text.slice(-4000)) || capped.includes("PROOF"))
  })
})
