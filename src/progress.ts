/**
 * Progress for a goal that is a plan.
 *
 * Two shapes are common. An agent using OpenCode's plan tool calls `todowrite`
 * with a list of `{ content, status }` items; a plan written into a reply or a
 * goal is a markdown checklist. Both reduce to the same `done/total` pair, which
 * every placement can show as `37/245 (15%)`.
 *
 * `todowrite` is the authoritative plan when it exists: it is the list the host
 * itself displays. A checklist in the latest reply is the fallback for agents
 * that keep their plan in prose. A checklist in the goal is the starting point.
 *
 * Cancelled items are not work anymore, so they are left out of the total.
 * `in_progress` is not done.
 *
 * Pure and host-free.
 */

export type ProgressSource = "plan" | "checklist" | "subgoals"

export type Progress = {
  done: number
  total: number
  source: ProgressSource
}

export type Todo = {
  content: string
  status: string
}

/** Percentage, rounded, clamped to 0..100. A 0 total is 0, not a division by zero. */
export function percent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

/** `37/245 (15%)` — the form used in every placement. */
export function formatProgress(progress: Progress): string {
  const total = Math.max(0, Math.floor(progress.total))
  const done = Math.max(0, Math.min(Math.floor(progress.done), total))
  return `${done}/${total} (${percent(done, total)}%)`
}

/** A filled bar for the panel. The width is the caller's, because the panel is. */
export function progressBar(progress: Progress, width: number): string {
  const size = Math.max(1, Math.floor(width))
  if (progress.total <= 0) return "░".repeat(size)
  const filled = Math.min(size, Math.max(0, Math.round((progress.done / progress.total) * size)))
  return "█".repeat(filled) + "░".repeat(size - filled)
}

/** True when both describe the same progress, so a poll does not repaint for nothing. */
export function sameProgress(a: Progress | undefined | null, b: Progress | undefined | null): boolean {
  if (!a || !b) return !a && !b
  return a.done === b.done && a.total === b.total && a.source === b.source
}

const asTodos = (value: unknown): Todo[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const todos: Todo[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const content = (item as { content?: unknown }).content
    const status = (item as { status?: unknown }).status
    if (typeof content !== "string" || typeof status !== "string") continue
    todos.push({ content, status })
  }
  // An empty array is a present plan with no items, not a missing field: the
  // caller must stop looking at older writes.
  return todos
}

/**
 * The latest `todowrite` call in a session, or undefined.
 *
 * Scanned newest-first so the list the host is showing now wins. The tool's
 * input carries the list while it runs; the completed state also puts it in
 * `metadata.todos`, which is preferred when present.
 */
export function latestTodos(messages: readonly unknown[]): Todo[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { type?: unknown; content?: unknown } | undefined
    if (!message || message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j] as
        | { type?: unknown; name?: unknown; state?: { input?: unknown; metadata?: unknown } }
        | undefined
      if (!part || part.type !== "tool") continue
      const name = String(part.name ?? "").toLowerCase()
      if (name !== "todowrite" && name !== "todo_write") continue
      const state = part.state ?? {}
      const metadata = (state.metadata ?? {}) as { todos?: unknown }
      const input = (state.input ?? {}) as { todos?: unknown }
      const todos = asTodos(metadata.todos) ?? asTodos(input.todos)
      if (todos) return todos
    }
  }
  return undefined
}

/** `completed` is done; `cancelled` is dropped from the plan; everything else is open. */
export function progressFromTodos(todos: readonly Todo[] | undefined): Progress | undefined {
  if (!todos || todos.length === 0) return undefined
  let done = 0
  let total = 0
  for (const todo of todos) {
    const status = todo.status.toLowerCase()
    if (status === "cancelled" || status === "canceled") continue
    total++
    if (status === "completed") done++
  }
  return total > 0 ? { done, total, source: "plan" } : undefined
}

const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+)$/

/**
 * Count markdown checkboxes, ignoring fenced code. Only lines with text after
 * the box count, so a stray `- [ ]` in a diagram is not a task.
 */
export function checklistProgress(text: string): Progress | undefined {
  let fenced = false
  let done = 0
  let total = 0
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = CHECKBOX.exec(line)
    if (!match) continue
    total++
    if (match[1].toLowerCase() === "x") done++
  }
  return total > 0 ? { done, total, source: "checklist" } : undefined
}

/**
 * The checklist in the latest assistant message, if that message has one. It
 * does not walk back to older turns: a stale plan is worse than no plan.
 */
export function latestAssistantChecklist(messages: readonly unknown[]): Progress | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { type?: unknown; content?: unknown } | undefined
    if (!message || message.type !== "assistant" || !Array.isArray(message.content)) continue
    const text = message.content
      .map((part) => part as { type?: unknown; text?: unknown })
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
    if (!text.trim()) continue
    return checklistProgress(text)
  }
  return undefined
}

/**
 * The plan's progress for a session: the host's todo list first, then a
 * checklist the agent keeps in its latest reply.
 */
export function progressFromMessages(messages: readonly unknown[]): Progress | undefined {
  const todos = latestTodos(messages)
  if (todos) {
    const progress = progressFromTodos(todos)
    if (progress) return progress
  }
  return latestAssistantChecklist(messages)
}

/**
 * The progress a goal shows when it has no live plan: whatever was stored at
 * the last turn, otherwise a checklist written into the goal itself.
 */
export function progressForGoal(goal: string, stored?: Progress | null): Progress | undefined {
  return stored ?? checklistProgress(goal)
}
