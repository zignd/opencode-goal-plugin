# Plan: rounds, a readable panel, and windows that scroll

Three misses: the panel shows only the latest turn and runs off the bottom with no scrollbar; there is no record of how long a round took or what it achieved beyond one judge sentence; and `/goal help` and `/goal settings` are long walls of text in a dialog that cannot scroll, and sometimes land in the transcript as a prompt.

Do not add a stop condition. Nothing here changes when the loop continues or stops.

## 1. The server records each round

A round is one turn from the moment the plugin sent the prompt to the moment the turn settled. Judge time is not part of it.

- [x] `GoalState` keeps `turnStartedAt` and a bounded `rounds` list. Each round has: number, start, end, duration, tool-call count, the verdict, the judge's reason, and `achieved`.
- [x] The list is capped (newest kept) and the number dropped is recorded, so a long goal cannot grow the stored state or every `changed` event without limit. `achieved` is capped in length.
- [x] The judge is asked for one more field: `achieved`, one or two sentences on what this turn concretely did (files changed, commands run and their result), not what remains. A reply without it is still valid. The round then falls back to a plain fact line (tool-call count) and says so, rather than inventing a summary.
- [x] `turnStartedAt` is set when the plugin sends a prompt: the `/goal` turn, a resume, and each continuation, after any backoff sleep. A round that was cut short (interrupted or failed) is recorded with that status and its real duration.
- [x] A `verify-cmd` demotion keeps the first pass's `achieved`. The second pass does not erase what the turn did.
- [x] Tests, with the clock injected: duration is end minus start; the cap drops the oldest and counts the drop; a missing `achieved` falls back; an interrupted turn is recorded; a resume starts a new `turnStartedAt`.

## 2. The view carries rounds

- [x] The RPC state schema gains `turnStartedAt` and `rounds` as optional properties, so an older TUI still validates. `additionalProperties: false` stays.
- [x] `src/rounds.ts` is pure and shared: duration formatting (`850ms`, `42s`, `3m 05s`, `1h 12m`), the one-line summary of a round, and the collapse state (which rounds are open, expand all, collapse all). It is tested without the host.

## 3. The side panel can be read

- [x] The panel body is a `scrollbox` with a visible scrollbar, so a long goal, proof, and reason scroll instead of running off the bottom.
- [x] Sections with a divider between them: status, goal, this round (turn count, bar, live elapsed time), last round (what it achieved, how long it took), proof, warnings.
- [x] The elapsed time ticks once a second only while the goal is active and the panel is mounted. The timer is cleared on unmount and on a state change to a finished goal.
- [x] A finished goal shows total time and the number of rounds.

## 4. A rounds window

- [x] `/goal rounds` opens a large centered window with a scrollbox. One section per round, newest first, each a header line (number, verdict, duration, the judge's reason) that expands to the full `achieved` text and the facts.
- [x] Clicking a header toggles it. "expand all" and "collapse all" are clickable. The newest round starts open.
- [x] With no TUI the command answers with a plain text summary, like `/goal status`.

## 5. Help and settings can be read

- [x] Help is data: titled sections (commands, budget and limits, completion contract, tools). The plain `HELP_TEXT` is derived from it, so the transcript fallback and the window cannot drift.
- [x] Settings render as sections too: current values with where each came from, how to change them, and notes.
- [x] Both open in the same scrolling, sectioned window as the rounds, replacing the plain-text `dialog.alert`.

## 6. `/goal help` and `/goal settings` do not start a prompt

A subcommand falls back to a synthetic transcript message when the server decides no TUI is present, and that message is a real prompt.

- [x] `tuiHere` compares canonical paths, and treats a recent presence from any TUI for the same project as present. A raw string compare of two spellings of one directory is the likeliest false "no TUI".
- [x] When the server does fall back, it logs which directory it looked for and what was stored, so the next occurrence is visible in `opencode.log`.
- [x] `/goal help` and `/goal settings` never use the fallback when the emit succeeded. Tests cover the path comparison and the fallback decision.
- [x] State plainly in the README what was verified: pure logic by tests, and the window layout only by a person looking at it.

## Looked at by a person

- [ ] In a real terminal: the panel scrolls with a long goal and shows a scrollbar, a click on a round header opens and closes it, `[expand all]` and `[collapse all]` work, `[close]` closes, and the help and settings windows scroll. Not done by the author: only the type checker and the unit tests have seen this code.

## Done when

- [x] `npm run check` is green with the new round, view, and path tests.
- [x] The README documents `/goal rounds`, the panel sections, and what the round time measures.
- [x] No new stop condition, and no change to the existing guards.
