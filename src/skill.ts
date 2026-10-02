/**
 * What a fresh session is told about writing a goal.
 *
 * The agent does not read this plugin. A skill is advertised by its description and
 * loaded when the agent calls `skill`, so the description has to name the situation.
 * `/draft-goal` does not depend on that choice: it carries the same instructions itself.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const SKILL_ID = "goal-contract"

export const SKILL_DESCRIPTION =
  "When the user asks for a /goal, a standing goal, or a goal prompt, load this " +
  "instead of guessing the field names or reading the plugin source."

export const SKILL_PATH = fileURLToPath(new URL("../skills/goal-contract.md", import.meta.url))

export function readSkillBody(path = SKILL_PATH): string {
  return readFileSync(path, "utf8")
}

export const DRAFT_USAGE = "Usage: /draft-goal <what must be true when it is done>"

/** The prompt `/draft-goal` submits. It writes the goal and does not start the work. */
export function draftPrompt(outcome: string, contract: string): string {
  return `Write a /goal for me to paste. Do not start the work, and do not run /goal yourself.

What must be true when it is done:
${outcome.trim()}

Follow this contract exactly:

${contract.trim()}`
}
