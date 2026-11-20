/**
 * Plan progress: the todo list, the reply checklist, the goal checklist, and the
 * compact string every placement shows.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  checklistProgress,
  formatProgress,
  latestAssistantChecklist,
  latestTodos,
  percent,
  progressBar,
  progressForGoal,
  progressFromMessages,
  progressFromTodos,
  sameProgress,
} from "../src/progress.ts"

describe("formatting", () => {
  test("37 of 245 is 15%, as the panel shows it", () => {
    assert.equal(formatProgress({ done: 37, total: 245, source: "plan" }), "37/245 (15%)")
  })

  test("rounds, clamps, and handles zero", () => {
    assert.equal(percent(1, 3), 33)
    assert.equal(percent(2, 3), 67)
    assert.equal(percent(1, 1), 100)
    assert.equal(percent(0, 3), 0)
    assert.equal(percent(5, 0), 0)
    assert.equal(formatProgress({ done: 300, total: 245, source: "plan" }), "245/245 (100%)")
    assert.equal(formatProgress({ done: -1, total: 10, source: "plan" }), "0/10 (0%)")
  })

  test("a bar fills by ratio and stays inside its width", () => {
    assert.equal(progressBar({ done: 1, total: 2, source: "plan" }, 4), "██░░")
    assert.equal(progressBar({ done: 0, total: 0, source: "plan" }, 3), "░░░")
    assert.equal(progressBar({ done: 2, total: 2, source: "plan" }, 3), "███")
  })

  test("sameProgress ignores object identity but not the numbers", () => {
    assert.equal(sameProgress(undefined, undefined), true)
    assert.equal(sameProgress(null, undefined), true)
    assert.equal(sameProgress({ done: 1, total: 2, source: "plan" }, { done: 1, total: 2, source: "plan" }), true)
    assert.equal(sameProgress({ done: 1, total: 2, source: "plan" }, { done: 1, total: 2, source: "checklist" }), false)
    assert.equal(sameProgress({ done: 1, total: 2, source: "plan" }, { done: 2, total: 2, source: "plan" }), false)
  })
})

describe("todos", () => {
  const todo = (content: string, status: string) => ({ content, status })

  test("completed is done; cancelled is not part of the plan; in_progress is open", () => {
    const progress = progressFromTodos([
      todo("a", "completed"),
      todo("b", "in_progress"),
      todo("c", "pending"),
      todo("d", "cancelled"),
    ])
    assert.deepEqual(progress, { done: 1, total: 3, source: "plan" })
  })

  test("an all-cancelled or empty list has no progress", () => {
    assert.equal(progressFromTodos([todo("a", "cancelled")]), undefined)
    assert.equal(progressFromTodos([]), undefined)
    assert.equal(progressFromTodos(undefined), undefined)
  })

  test("latestTodos reads metadata.todos first, then input.todos", () => {
    const fromMetadata = {
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "todowrite",
          state: { status: "completed", metadata: { todos: [todo("a", "completed")] }, input: {} },
        },
      ],
    }
    assert.deepEqual(latestTodos([fromMetadata]), [todo("a", "completed")])

    const fromInput = {
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "todo_write",
          state: { status: "running", input: { todos: [todo("b", "pending")] }, metadata: {} },
        },
      ],
    }
    assert.deepEqual(latestTodos([fromInput]), [todo("b", "pending")])
  })

  test("the newest todowrite wins", () => {
    const message = (content: string) => ({
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "todowrite",
          state: { status: "completed", metadata: { todos: [todo(content, "pending")] }, input: {} },
        },
      ],
    })
    assert.deepEqual(latestTodos([message("old"), message("new")]), [todo("new", "pending")])
  })

  test("a later empty write wins over an older list", () => {
    const message = (todos: unknown[]) => ({
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "todowrite",
          state: { status: "completed", metadata: { todos }, input: {} },
        },
      ],
    })
    assert.deepEqual(latestTodos([message([todo("old", "pending")]), message([])]), [])
  })

  test("ignores other tools and user messages; a malformed write is an empty plan", () => {
    const messages = [
      { type: "user", content: [{ type: "tool", name: "todowrite", state: { input: { todos: [todo("a", "completed")] } } }] },
      { type: "assistant", content: [{ type: "tool", name: "read", state: { input: { todos: [todo("b", "completed")] } } }] },
      { type: "assistant", content: [{ type: "tool", name: "todowrite", state: { input: { todos: [{ nope: true }] } } }] },
    ]
    assert.deepEqual(latestTodos(messages), [])
  })
})

describe("checklists", () => {
  test("counts checked and unchecked markdown boxes", () => {
    const progress = checklistProgress("- [x] one\n- [ ] two\n* [X] three\n1. [ ] four")
    assert.deepEqual(progress, { done: 2, total: 4, source: "checklist" })
  })

  test("ignores fenced code and boxes with no text", () => {
    const text = ["- [x] real", "```", "- [x] example", "```", "- [ ]"].join("\n")
    assert.deepEqual(checklistProgress(text), { done: 1, total: 1, source: "checklist" })
  })

  test("no boxes means no progress", () => {
    assert.equal(checklistProgress("just prose"), undefined)
    assert.equal(checklistProgress(""), undefined)
  })

  test("the latest assistant message is the only one considered", () => {
    const withBoxes = { type: "assistant", content: [{ type: "text", text: "- [x] one\n- [ ] two" }] }
    const without = { type: "assistant", content: [{ type: "text", text: "no plan here" }] }
    assert.deepEqual(latestAssistantChecklist([withBoxes]), { done: 1, total: 2, source: "checklist" })
    assert.equal(latestAssistantChecklist([withBoxes, without]), undefined)
  })
})

describe("choosing the plan", () => {
  test("todowrite wins over a reply checklist", () => {
    const messages = [
      { type: "assistant", content: [{ type: "text", text: "- [ ] one\n- [ ] two" }] },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "todowrite",
            state: { status: "completed", metadata: { todos: [{ content: "one", status: "completed" }] }, input: {} },
          },
        ],
      },
    ]
    assert.deepEqual(progressFromMessages(messages), { done: 1, total: 1, source: "plan" })
  })

  test("a reply checklist is the fallback", () => {
    const messages = [{ type: "assistant", content: [{ type: "text", text: "- [x] one\n- [ ] two" }] }]
    assert.deepEqual(progressFromMessages(messages), { done: 1, total: 2, source: "checklist" })
  })

  test("the stored plan wins over the goal's own checklist", () => {
    const goal = "- [x] one\n- [ ] two"
    assert.deepEqual(progressForGoal(goal), { done: 1, total: 2, source: "checklist" })
    assert.deepEqual(progressForGoal(goal, { done: 5, total: 9, source: "plan" }), {
      done: 5,
      total: 9,
      source: "plan",
    })
    assert.equal(progressForGoal("no plan"), undefined)
  })
})
