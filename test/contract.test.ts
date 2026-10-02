import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { parseGoal, renderContract } from "../src/contract.ts"

describe("parseGoal", () => {
  test("keeps a blank line inside a fenced field, and out of the headline", () => {
    const { goal, contract } = parseGoal(`Port auth to JWT
\`\`\`verify
bash scripts/track-plan.sh shows Phase 20 strictly above 72

the last five-gate log is green
\`\`\``)
    assert.equal(goal, "Port auth to JWT")
    assert.equal(
      contract.verification,
      "bash scripts/track-plan.sh shows Phase 20 strictly above 72\n\nthe last five-gate log is green",
    )
  })

  test("leaves a fence with an unknown info string in the headline", () => {
    const { goal, contract } = parseGoal(`Fix the parser
\`\`\`python
verify: this is a quote, not a field
\`\`\`
constraints: keep the commas`)
    assert.match(goal, /```python/)
    assert.match(goal, /verify: this is a quote, not a field/)
    assert.equal(contract.verification, undefined)
    assert.equal(contract.constraints, "keep the commas")
  })

  test("a one-line field, a blank line, then headline text", () => {
    const { goal, contract } = parseGoal(`verify: pytest tests/auth passes

Port auth to JWT`)
    assert.equal(contract.verification, "pytest tests/auth passes")
    assert.equal(goal, "Port auth to JWT")
  })

  test("an unclosed fence is headline, not a swallowed field", () => {
    const { goal, contract } = parseGoal(`Do the thing
\`\`\`verify
bash scripts/track-plan.sh`)
    assert.match(goal, /```verify/)
    assert.match(goal, /bash scripts\/track-plan.sh/)
    assert.equal(contract.verification, undefined)
  })

  test("the one-line form, including continuation lines, is unchanged", () => {
    const { goal, contract } = parseGoal(`Port the auth service from session cookies to JWT
verify: pytest tests/auth passes
and the lint is clean
constraints: keep the /login response shape unchanged
scope: only services/auth and its tests
stop when: a database schema migration is required`)
    assert.equal(goal, "Port the auth service from session cookies to JWT")
    assert.equal(contract.verification, "pytest tests/auth passes and the lint is clean")
    assert.equal(contract.constraints, "keep the /login response shape unchanged")
    assert.equal(contract.boundaries, "only services/auth and its tests")
    assert.equal(contract.stopWhen, "a database schema migration is required")
  })

  test("a colon in ordinary prose is not a field", () => {
    const { goal, contract } = parseGoal("Fix bug: the parser drops commas")
    assert.equal(goal, "Fix bug: the parser drops commas")
    assert.deepEqual(contract, {})
  })

  test("several verify-cmd lines, and several fences, are several commands", () => {
    const { contract } = parseGoal(`Re-read the log
verify-cmd: grep -q passed build/log
verified by running: bash scripts/track-plan.sh
\`\`\`verify-cmd
tail -n 20 build/log

grep green build/log
\`\`\``)
    assert.deepEqual(contract.verifyCmd, [
      "grep -q passed build/log",
      "bash scripts/track-plan.sh",
      "tail -n 20 build/log\n\ngrep green build/log",
    ])
  })
})

describe("renderContract", () => {
  test("prints a fenced field with its line breaks", () => {
    const { contract } = parseGoal(`Port auth
\`\`\`verify
line one

line two
\`\`\``)
    const rendered = renderContract(contract)
    assert.match(rendered, /Proof it is done:\nline one\n\nline two/)
  })

  test("prints a one-line field as a single line", () => {
    const { contract } = parseGoal("verify: pytest tests/auth passes")
    assert.equal(renderContract(contract), "\n\n- Proof it is done: pytest tests/auth passes")
  })
})
