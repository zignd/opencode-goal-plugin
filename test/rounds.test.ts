import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  collapseAll,
  expandAll,
  factLine,
  formatDuration,
  initialOpen,
  makeRound,
  MAX_ACHIEVED,
  pushRound,
  roundHeader,
  sectionsFromText,
  toggleOpen,
  totalMs,
} from "../src/rounds.ts"

const round = (n: number, extra: Partial<Parameters<typeof makeRound>[0]> = {}) =>
  makeRound({ n, startedAt: 1000, endedAt: 4000, toolCalls: 2, outcome: "continue", ...extra })

describe("formatDuration", () => {
  test("reads at every scale", () => {
    assert.equal(formatDuration(850), "850ms")
    assert.equal(formatDuration(42_000), "42s")
    assert.equal(formatDuration(185_000), "3m 05s")
    assert.equal(formatDuration(4_320_000), "1h 12m")
    assert.equal(formatDuration(-5), "0s")
    assert.equal(formatDuration(Number.NaN), "0s")
  })
})

describe("makeRound", () => {
  test("the duration is end minus start, and never negative", () => {
    assert.equal(round(1).ms, 3000)
    assert.equal(makeRound({ n: 1, startedAt: 9000, endedAt: 1000, toolCalls: 0, outcome: "paused" }).ms, 0)
  })

  test("keeps the judge's summary, capped in length", () => {
    const kept = round(1, { achieved: "Edited two files and the tests passed." })
    assert.equal(kept.achieved, "Edited two files and the tests passed.")
    assert.equal(kept.fallback, undefined)
    const long = round(2, { achieved: "x".repeat(MAX_ACHIEVED * 3) })
    assert.ok(long.achieved.length <= MAX_ACHIEVED)
    assert.match(long.achieved, /…$/)
  })

  test("a missing summary falls back to a plain fact line and says so", () => {
    const fallback = round(1, { achieved: "   ", toolCalls: 3 })
    assert.equal(fallback.achieved, factLine(3))
    assert.equal(fallback.fallback, true)
    assert.match(factLine(0), /No tools ran/)
    assert.match(factLine(1), /1 tool call ran/)
  })

  test("an interrupted turn is recorded with its real duration", () => {
    const cut = round(4, { outcome: "interrupted", reason: "interrupted (user)" })
    assert.equal(cut.outcome, "interrupted")
    assert.equal(cut.ms, 3000)
  })
})

describe("pushRound", () => {
  test("drops the oldest past the cap and counts the drop", () => {
    let state = { rounds: [] as ReturnType<typeof round>[], dropped: 0 }
    for (let n = 1; n <= 5; n++) state = pushRound(state.rounds, state.dropped, round(n), 3)
    assert.deepEqual(state.rounds.map((r) => r.n), [3, 4, 5])
    assert.equal(state.dropped, 2)
  })

  test("a round recorded twice is replaced, not duplicated", () => {
    const first = pushRound([], 0, round(1, { reason: "old" }))
    const again = pushRound(first.rounds, first.dropped, round(1, { reason: "new" }))
    assert.equal(again.rounds.length, 1)
    assert.equal(again.rounds[0].reason, "new")
  })

  test("totals the time across rounds", () => {
    assert.equal(totalMs([round(1), round(2)]), 6000)
  })
})

describe("roundHeader", () => {
  test("number, outcome, time, then the reason", () => {
    assert.equal(roundHeader(round(3, { outcome: "done", reason: "the log is green" })), "#3 ✓ 3s  the log is green")
    assert.equal(roundHeader(round(1)), "#1 → 3s")
  })
})

describe("collapse state", () => {
  const rounds = [round(1), round(2), round(3)]

  test("the newest starts open", () => {
    assert.deepEqual([...initialOpen(rounds)], [3])
    assert.deepEqual([...initialOpen([])], [])
  })

  test("toggling opens and closes one round and leaves the rest", () => {
    const open = toggleOpen(initialOpen(rounds), 1)
    assert.deepEqual([...open].sort(), [1, 3])
    assert.deepEqual([...toggleOpen(open, 3)], [1])
  })

  test("expand all and collapse all", () => {
    assert.deepEqual([...expandAll(rounds)], [1, 2, 3])
    assert.equal(collapseAll().size, 0)
  })

  test("toggling does not mutate the set it was given", () => {
    const open = initialOpen(rounds)
    toggleOpen(open, 1)
    assert.deepEqual([...open], [3])
  })
})

describe("sectionsFromText", () => {
  test("splits on blank lines and titles each block", () => {
    const sections = sectionsFromText("a\nb\n\nc\n\n\nd", ["One", "Two"])
    assert.deepEqual(sections, [
      { title: "One", lines: ["a", "b"] },
      { title: "Two", lines: ["c"] },
      { title: "Two", lines: ["d"] },
    ])
  })

  test("empty text is no sections", () => {
    assert.deepEqual(sectionsFromText("  \n\n ", ["One"]), [])
  })
})

import { roundsReport, withRound } from "../src/rounds.ts"
import { parseVerdict } from "../src/verdict.ts"
import { buildJudgePrompt } from "../src/prompt.ts"

describe("withRound", () => {
  const base = { turns: 2, turnStartedAt: 10_000, rounds: [] as ReturnType<typeof round>[], roundsDropped: 0 }

  test("numbers the round like the turn counter, and times it from the prompt to the settle", () => {
    const next = withRound(base, { settledAt: 70_000, outcome: "continue", toolCalls: 4, achieved: "Ran the suite." })
    assert.equal(next.rounds[0].n, 3)
    assert.equal(next.rounds[0].ms, 60_000)
    assert.equal(next.rounds[0].achieved, "Ran the suite.")
  })

  test("a goal with no recorded start reports 0, not a guess", () => {
    const next = withRound({ ...base, turnStartedAt: undefined }, { settledAt: 70_000, outcome: "continue", toolCalls: 0 })
    assert.equal(next.rounds[0].ms, 0)
  })

  test("a resume that restarts the clock times only the new turn", () => {
    const first = withRound(base, { settledAt: 20_000, outcome: "paused", toolCalls: 1 })
    const resumed = { ...first, turns: 0, turnStartedAt: 500_000 }
    const second = withRound(resumed, { settledAt: 530_000, outcome: "done", toolCalls: 2 })
    assert.equal(second.rounds[second.rounds.length - 1].ms, 30_000)
  })

  test("does not mutate the state it was given", () => {
    withRound(base, { settledAt: 20_000, outcome: "continue", toolCalls: 1 })
    assert.equal(base.rounds.length, 0)
  })
})

describe("roundsReport", () => {
  test("says so when there is nothing yet", () => {
    assert.equal(roundsReport([]), "No rounds recorded yet.")
  })

  test("newest first, with the total and the number not kept", () => {
    const text = roundsReport([round(1, { achieved: "First." }), round(2, { achieved: "Second." })], 3)
    assert.match(text, /2 rounds, 6s in all/)
    assert.match(text, /3 earlier rounds not kept/)
    assert.ok(text.indexOf("#2") < text.indexOf("#1"))
    assert.match(text, /Second\./)
  })
})

describe("parseVerdict", () => {
  test("reads the achieved field, and tolerates a judge that leaves it out", () => {
    assert.equal(parseVerdict('{"verdict":"continue","reason":"r","achieved":"Edited a.ts."}').achieved, "Edited a.ts.")
    assert.equal(parseVerdict('{"verdict":"continue","reason":"r"}').achieved, "")
    assert.equal(parseVerdict('{"verdict":"continue","reason":"r","achieved":7}').achieved, "")
  })

  test("still accepts the legacy done shape and rejects an unknown verdict", () => {
    assert.equal(parseVerdict('{"done":true,"reason":"ok"}').verdict, "done")
    assert.throws(() => parseVerdict('{"verdict":"maybe"}'), /unknown verdict/)
  })
})

describe("judge prompt", () => {
  test("asks for what this turn did, and never for what remains", () => {
    const text = buildJudgePrompt({
      goal: "g", contract: "", turn: "1", maxTurns: "20", toolCalls: "0", stalled: "0",
      observing: "0", previous: "p", response: "r", evidence: "<evidence>\nNo proof has been recorded yet.\n</evidence>",
    })
    assert.match(text, /"achieved"/)
    assert.match(text, /THIS turn concretely did/)
    assert.match(text, /never what remains/)
  })
})

import { HELP_SECTIONS, HELP_TEXT } from "../src/help.ts"
import { renderSettings, resolve, NO_OVERRIDES } from "../src/settings.ts"

describe("help", () => {
  test("every section is titled and the plain text carries all of them", () => {
    for (const section of HELP_SECTIONS) {
      assert.ok(section.title.length > 0)
      assert.ok(section.lines.length > 0)
      assert.ok(HELP_TEXT.includes(section.title))
    }
  })

  test("names the subcommands this plugin answers, including the new ones", () => {
    for (const word of ["/goal rounds", "/goal status", "/goal settings", "verify-cmd", "/draft-goal"]) {
      assert.ok(HELP_TEXT.includes(word), `help does not mention ${word}`)
    }
  })
})

describe("settings window sections", () => {
  test("the rendered summary splits into values, how to change them, and notes", () => {
    const text = renderSettings(resolve({ maxTurns: 20, stall: 2, poll: 3, quiet: false, judge: null }, NO_OVERRIDES))
    const sections = sectionsFromText(text, ["Current values", "Change for this session", "Notes"])
    assert.deepEqual(sections.map((section) => section.title), ["Current values", "Change for this session", "Notes"])
    assert.match(sections[0].lines.join("\n"), /Turn budget/)
    assert.match(sections[1].lines.join("\n"), /\/goal budget/)
  })
})
