/**
 * Subgoals: parsing, persistence helpers, the judge's met list, and the prompt
 * blocks. The server writes these into the goal state; the pure functions are
 * where the numbering and the done/continue rule are pinned.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  addSubgoal,
  allSubgoalsMet,
  applyMet,
  applySubgoalVerdict,
  mergeSubgoals,
  parseSubgoalArgument,
  removeSubgoal,
  renderSubgoalBlock,
  renderSubgoalCriteria,
  renderSubgoalList,
  subgoalProgress,
  subgoalReport,
  type Subgoal,
} from "../src/subgoals.ts"

const list = (...texts: string[]): Subgoal[] => texts.map((text) => ({ text, met: false }))

describe("parseSubgoalArgument", () => {
  test("no argument lists", () => {
    assert.deepEqual(parseSubgoalArgument(""), { kind: "list" })
    assert.deepEqual(parseSubgoalArgument("   "), { kind: "list" })
  })

  test("plain text is a new criterion", () => {
    assert.deepEqual(parseSubgoalArgument("add a regression test"), {
      kind: "add",
      text: "add a regression test",
    })
  })

  test("clear is exact, so a criterion can start with the word", () => {
    assert.deepEqual(parseSubgoalArgument("clear"), { kind: "clear" })
    assert.deepEqual(parseSubgoalArgument("CLEAR"), { kind: "clear" })
    assert.deepEqual(parseSubgoalArgument("clear the cache"), {
      kind: "add",
      text: "clear the cache",
    })
  })

  test("remove takes a 1-based number", () => {
    assert.deepEqual(parseSubgoalArgument("remove 2"), { kind: "remove", n: 2 })
    assert.deepEqual(parseSubgoalArgument("  REMOVE   12  "), { kind: "remove", n: 12 })
  })

  test("remove without a usable number is an error or a criterion, never a silent removal", () => {
    assert.equal(parseSubgoalArgument("remove").kind, "invalid")
    assert.equal(parseSubgoalArgument("remove 0").kind, "invalid")
    assert.deepEqual(parseSubgoalArgument("remove the legacy path"), {
      kind: "add",
      text: "remove the legacy path",
    })
    assert.deepEqual(parseSubgoalArgument("remove 2.5"), { kind: "add", text: "remove 2.5" })
  })
})

describe("addSubgoal", () => {
  test("appends unchecked and keeps the existing list", () => {
    const before = list("one")
    const after = addSubgoal(before, "two")
    assert.deepEqual(after, [
      { text: "one", met: false },
      { text: "two", met: false },
    ])
    assert.deepEqual(before, [{ text: "one", met: false }], "the input is not mutated")
  })

  test("collapses whitespace and caps a very long criterion", () => {
    const added = addSubgoal(undefined, "  a\n\n  b  ")
    assert.equal(added[0].text, "a b")
    const long = addSubgoal(undefined, "x".repeat(900))[0].text
    assert.ok(long.length < 900)
    assert.match(long, /…$/)
  })
})

describe("removeSubgoal", () => {
  test("removes the nth item and renumbers the rest", () => {
    const result = removeSubgoal(list("one", "two", "three"), 2)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.removed.text, "two")
    assert.deepEqual(result.subgoals.map((subgoal) => subgoal.text), ["one", "three"])
  })

  test("rejects an out-of-range or non-integer number", () => {
    for (const n of [0, -1, 4, 2.5]) {
      const result = removeSubgoal(list("one", "two", "three"), n)
      assert.equal(result.ok, false, String(n))
    }
  })

  test("rejects an empty list", () => {
    const result = removeSubgoal(undefined, 1)
    assert.equal(result.ok, false)
  })
})

describe("met tracking", () => {
  test("applyMet marks exactly the listed indices and ignores the rest", () => {
    const next = applyMet(list("one", "two", "three"), [2, 9, 2, 0, -1])
    assert.deepEqual(next.map((subgoal) => subgoal.met), [false, true, false])
  })

  test("subgoalProgress counts met over total", () => {
    const progress = subgoalProgress([
      { text: "one", met: true },
      { text: "two", met: false },
      { text: "three", met: true },
    ])
    assert.deepEqual(progress, { done: 2, total: 3, source: "subgoals" })
    assert.equal(subgoalProgress(undefined), undefined)
    assert.equal(subgoalProgress([]), undefined)
  })

  test("allSubgoalsMet is true for an empty list, and false for one open criterion", () => {
    assert.equal(allSubgoalsMet(undefined), true)
    assert.equal(allSubgoalsMet([]), true)
    assert.equal(allSubgoalsMet([{ text: "one", met: true }]), true)
    assert.equal(allSubgoalsMet([{ text: "one", met: false }]), false)
  })
})

describe("applySubgoalVerdict", () => {
  const open = list("one", "two")

  test("done with no met list marks every criterion met", () => {
    const result = applySubgoalVerdict(open, { verdict: "done", reason: "all good" })
    assert.equal(result.verdict.verdict, "done")
    assert.deepEqual(result.subgoals?.map((subgoal) => subgoal.met), [true, true])
  })

  test("done with a partial met list is demoted to continue", () => {
    const result = applySubgoalVerdict(open, { verdict: "done", reason: "looks done", met: [1] })
    assert.equal(result.verdict.verdict, "continue")
    assert.match(result.verdict.reason, /subgoal 2 is not met yet/)
    assert.match(result.verdict.reason, /two/)
    assert.deepEqual(result.subgoals?.map((subgoal) => subgoal.met), [true, false])
  })

  test("done with a met list that only contains out-of-range numbers is demoted", () => {
    const result = applySubgoalVerdict(open, { verdict: "done", reason: "looks done", met: [9, 10] })
    assert.equal(result.verdict.verdict, "continue")
    assert.deepEqual(result.subgoals?.map((subgoal) => subgoal.met), [false, false])
  })

  test("continue with a met list updates the list exactly", () => {
    const result = applySubgoalVerdict(open, { verdict: "continue", reason: "not yet", met: [2] })
    assert.equal(result.verdict.verdict, "continue")
    assert.deepEqual(result.subgoals?.map((subgoal) => subgoal.met), [false, true])
  })

  test("continue without a met list leaves the list alone", () => {
    const result = applySubgoalVerdict([{ text: "one", met: true }], { verdict: "continue", reason: "not yet" })
    assert.deepEqual(result.subgoals?.map((subgoal) => subgoal.met), [true])
  })

  test("no subgoals leaves the verdict untouched", () => {
    const verdict = { verdict: "done" as const, reason: "all good" }
    const result = applySubgoalVerdict(undefined, verdict)
    assert.equal(result.verdict, verdict)
    assert.equal(result.subgoals, undefined)
  })
})

describe("mergeSubgoals", () => {
  test("an unchanged list takes the judge's met marks", () => {
    const current = list("one", "two")
    const judged = [
      { text: "one", met: true },
      { text: "two", met: false },
    ]
    assert.deepEqual(mergeSubgoals(current, judged), judged)
  })

  test("a criterion added while the judge ran is kept, and met marks carry over by text", () => {
    const current = list("one", "two", "three")
    const judged = [
      { text: "one", met: true },
      { text: "two", met: false },
    ]
    assert.deepEqual(mergeSubgoals(current, judged), [
      { text: "one", met: true },
      { text: "two", met: false },
      { text: "three", met: false },
    ])
  })

  test("a criterion removed while the judge ran does not come back", () => {
    const current = [{ text: "two", met: false }]
    const judged = [
      { text: "one", met: true },
      { text: "two", met: true },
    ]
    assert.deepEqual(mergeSubgoals(current, judged), [{ text: "two", met: true }])
  })

  test("a missing side is copied, not aliased", () => {
    assert.deepEqual(mergeSubgoals(undefined, list("one")), [{ text: "one", met: false }])
    assert.deepEqual(mergeSubgoals(list("one"), undefined), [{ text: "one", met: false }])
    assert.equal(mergeSubgoals(undefined, undefined), undefined)
  })
})

describe("rendering", () => {
  test("the numbered list uses checkboxes", () => {
    assert.equal(
      renderSubgoalList([
        { text: "one", met: true },
        { text: "two", met: false },
      ]),
      "1. [x] one\n2. [ ] two",
    )
    assert.equal(renderSubgoalList([]), "No subgoals.")
  })

  test("the agent's block says every criterion must be met", () => {
    const block = renderSubgoalBlock([{ text: "one", met: false }])
    assert.match(block, /Additional criteria the user added mid-goal/)
    assert.match(block, /all must be met/)
    assert.match(block, /1\. \[ \] one/)
    assert.equal(renderSubgoalBlock([]), "")
  })

  test("the judge's block omits the met marks so it judges fresh", () => {
    const block = renderSubgoalCriteria([{ text: "one", met: true }])
    assert.match(block, /<additional criteria>/)
    assert.match(block, /1\. one/)
    assert.doesNotMatch(block, /\[x\]/)
    assert.equal(renderSubgoalCriteria([]), "")
  })

  test("the transcript report names the ratio and every criterion", () => {
    const report = subgoalReport([
      { text: "one", met: true },
      { text: "two", met: false },
    ])
    assert.match(report, /Subgoals 1\/2 met \(50%\)/)
    assert.match(report, /1\. \[x\] one/)
    assert.match(report, /2\. \[ \] two/)
    assert.equal(subgoalReport([]), "No subgoals. Add one with /subgoal <text>.")
  })
})
