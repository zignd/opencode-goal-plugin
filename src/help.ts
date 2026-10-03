import type { Section } from "./rounds.js"

/**
 * The command reference as titled sections. The window shows these as they are, and
 * `HELP_TEXT` is derived from them, so the transcript fallback and the window cannot drift.
 */
export const HELP_SECTIONS: Section[] = [
  {
    title: "Run a goal",
    lines: [
      "/goal <text>           set the goal and start working",
      "/goal status           the goal, its state, turns used, last round",
      "/goal rounds           every round: how long it took, what it achieved",
      "/goal pause            stop auto-continuation, keep the goal",
      "/goal resume           resume with a fresh turn budget",
      "/goal clear            drop the goal",
      "/draft-goal <outcome>  write a /goal for you to paste, without starting",
    ],
  },
  {
    title: "Limits and the judge",
    lines: [
      "/goal budget <n|inf|default>   turns before the loop pauses",
      "/goal stall <n>                turns with no tools before it gives up",
      "/goal poll <n>                 turns re-reading an unchanged result",
      "/goal quiet <on|off>           panel replaces the transcript notices",
      "/goal judge <model>            provider/model[#variant] for each verdict",
      "/goal settings                 change each setting, and see where it came from",
    ],
  },
  {
    title: "Where it is shown (TUI)",
    lines: [
      "/goal panel     open or close the side panel",
      "/goal display   which placements are on",
      "/goal help      this window",
    ],
  },
  {
    title: "Completion contract",
    lines: [
      "Lines the judge uses to decide done. A field that needs a blank line is a fence.",
      "  verify: / verified by:    the proof, as a description the judge reads",
      "  verify-cmd:               a cheap re-read the plugin runs after a first done",
      "  constraints: / preserve:  what must not change",
      "  scope: / boundaries:      what is in scope",
      "  outcome:                  the end state that must be true",
      "  stop when:                when the agent should call goal_blocked",
    ],
  },
  {
    title: "How it stops",
    lines: ["The loop stops on: done, judged unachievable, stalled, repeated, or out of turns."],
  },
]

export const HELP_TEXT = HELP_SECTIONS.map((section) => [section.title, ...section.lines].join("\n")).join("\n\n")
