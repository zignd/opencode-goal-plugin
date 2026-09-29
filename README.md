# opencode-goal-plugin

A persistent `/goal` command for **OpenCode 2**. Set a standing goal and the agent keeps
working on it across turns — no re-typing "keep going" — until the goal is achieved, judged
unachievable, stalled, or out of turns.

```
/goal Fix every failing test in tests/api and make sure scripts/run-tests.sh passes for that directory
```

> **Targets OpenCode `2.0.18`** and the V2 plugin API (`@opencode/plugin` `^2.0.18`).
> It does not work on OpenCode 1.x.

---

## Why a plugin and not a custom command?

OpenCode custom commands (`.opencode/commands/*.md`) are prompt templates. They can expand
arguments and shell blocks, but they cannot react to a turn finishing, call a model outside
the conversation, or feed a prompt back into a session. A goal loop needs all three, so this
is a V2 server plugin.

## How it works

1. `/goal <text>` stores the goal against the current session and submits the first turn.
2. When the turn settles, a **judge model** reads the goal and the agent's last reply and
   returns strict JSON: `{"verdict": "done" | "blocked" | "continue", "reason": "…"}`.
3. `continue` posts a continuation prompt straight back into the same session, and the loop
   repeats. The judge sees the loop's own history (turn number, tool calls last turn,
   consecutive no-change turns, its previous verdict), so it can recognise a loop it is
   inside of.
4. Anything other than `continue` stops the loop and reports why.

The judge is called through `ctx.generate.text`, which creates no session and adds nothing to
the transcript. By default it runs on the same model as the session; point `judgeModel` at a
small fast model to cut cost (the call is ~200 output tokens, once per turn).

## Features

- **Standing goals** that survive across turns, stored per session in durable plugin storage.
  An active goal also survives an OpenCode restart and picks the loop back up on your next
  message.
- **Completion contracts** — attach `verify:`, `constraints:`, `scope:` and `stop when:`
  lines to a goal so the judge knows what "done" actually means instead of guessing.
- **Five independent stop conditions**, three of them deterministic (see below), so a runaway
  loop cannot burn a budget unattended.
- **Per-session state** — goals are keyed by session ID, so several projects can have
  unrelated goals running at once.
- **User messages always win** — interrupting or a failing turn pauses the loop instead of
  being retried forever.
- **Status control** — `/goal status`, `pause`, `resume`, `clear`.

## Install

### Globally (recommended, all projects)

```sh
git clone https://github.com/zignd/opencode-goal-plugin.git ~/.config/opencode/plugins/goal
cd ~/.config/opencode/plugins/goal
npm install
```

`~/.config/opencode/plugins/` is auto-discovered, so the clone is all you need. To confirm,
type `/` in the TUI — `/goal` should be in the list.

> Do **not** use `opencode plugin list` to verify a discovery install. That command reports
> plugins declared in the `plugins` array of your config, so a plugin installed purely by
> directory discovery will not appear in it even while working perfectly.

### As a configured package plugin

```sh
opencode plugin add github:zignd/opencode-goal-plugin
```

### Per project only

```sh
git clone https://github.com/zignd/opencode-goal-plugin.git .opencode/plugins/goal
cd .opencode/plugins/goal && npm install
```

### Options

The `plugins` array is also the only way to pass configuration, so add it to
`~/.config/opencode/opencode.json` (or a project `opencode.json`) if you want to change the
defaults:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/goal",
      "options": {
        "maxTurns": 20,
        "stallLimit": 2,
        "judgeModel": { "providerID": "openrouter", "id": "google/gemini-3-flash-preview" }
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `maxTurns` | `20` | Automatic continuation turns before the loop auto-pauses. The initial `/goal` turn is not counted, so the default allows 21 agent executions in total. See below. |
| `stallLimit` | `2` | Consecutive turns that ran **no tools** before the loop is declared stalled. |
| `judgeModel` | session model | Model used for the `done` / `continue` / `blocked` verdict. |
| `quiet` | `false` | Stop posting the loop's turn banner and completion notices into the transcript while the panel is open. |

### What a "turn" is

A **turn** is one complete run of the agent loop. One prompt goes in, the model works —
calling as many tools as it needs — and produces a final reply. That reply ends the turn,
and OpenCode emits `session.execution.succeeded`, which is the event this plugin waits for
before asking the judge anything.

A turn is **not** a tool call, and **not** a message. A single turn can contain a dozen tool
calls and a long final answer, and it still counts once.

`maxTurns` counts only the **continuation** turns that the plugin injects after the judge
answers `continue`. The original `/goal <text>` turn is turn zero and is not counted, so the
default budget looks like this:

```text
 1        the /goal prompt itself
+ 20      automatic continuations, numbered 1/20 … 20/20
─────
 21      agent executions before the loop pauses
```

The judge is consulted once per settled turn, including the last one, so a full budget is 21
agent executions and 21 judge calls.

You can watch the counter in the transcript:

```text
↻ [continuing toward your standing goal — turn 3/20]
```

and in `/goal status` as `3/20 turns used`. `/goal resume` resets it to zero, which hands you
another full budget.

Treat the budget as a ceiling, not a target. Every turn is a real agent execution plus a
judge call, so in practice the `done`, stall and repetition guards fire long before it does.

If you are content with the defaults, omit this block entirely — the directory is still
discovered. Declaring it here is not a second copy: the command registry is keyed by name, so
`/goal` resolves to one command either way, and only the instance owning a session's directory
drives that session's loop.

## Usage

| Command | Effect |
| --- | --- |
| `/goal <text>` | Set or replace the goal and immediately start the first turn. |
| `/goal status` | Show the goal, its state, turns used, and the last judge reason. |
| `/goal pause` | Stop auto-continuation but keep the goal. |
| `/goal resume` | Resume the loop with a fresh turn budget. |
| `/goal clear` | Drop the goal entirely. |
| `/goal panel` | Open or close the panel. TUI only; elsewhere it says so. Works whether the panel is open or closed. |
| `/goal display` | Choose where the goal is shown. TUI only. |
| `/goal help` | The full command reference, in a dialog. |

### The session panel (TUI)

In the terminal UI the loop reports itself in the session's right-hand panel, which opens by
itself when you start a goal:

```text
● goal running
Fix every failing test in tests/api
proof: scripts/run-tests.sh passes
████████░░░░░░░░ 3/20 turns
The agent fixed two tests but tests/api/test_auth.py still fails
```

It shows the goal, the `verify:` line it is working toward, a turn counter, the stalled and
repeating counters when they are non-zero, and the judge's last reason. When the loop reaches
`done`, `blocked` or paused, you get a toast instead of a message in the transcript.

Dismiss the panel with its own control, or toggle it with `/goal panel`.

**The panel adds to the transcript, it does not replace it.** The loop still writes a
`↻ [continuing toward your standing goal — turn N/M]` banner on every continuation and a
`✓ Goal achieved` / `🚫 Goal judged unachievable` / `⏸ Goal paused` notice when it stops, so
scrolling back tells the story. The panel is the live view; the transcript is the record.

Those notices cost a model call each, because a synthetic session message is a real prompt. Set
`quiet: true` to suppress them while the panel is open, if you would rather have a silent
transcript. It only takes effect when a panel is actually displaying the state, so it can never
hide the loop in a headless client where nothing would be shown instead.

A TUI only ever marks **its own location, and only the session its panel is showing**, so a
terminal open in one project will not affect a headless run in another.

> Editing `index.ts` or `rpc.ts` hot-reloads. Editing `tui.tsx` does **not** — restart the TUI
> to pick it up, because the discovered `tui.ts` entrypoint is what gets watched.

### Querying a goal while it is running

`/goal status`, `/goal pause`, `/goal resume` and `/goal clear` all work while the loop is
running. They always answer in the transcript, panel open or not — they are replies to
something you typed, not loop reporting. None of them resets the turn counter, and `pause` and
`clear` stop the loop on the next boundary.

There is one caveat, and it is a limitation of the host rather than a choice. OpenCode gives a
plugin no way to write a message into a session without starting an execution, so the status
report is delivered as a real prompt. The agent sees it and answers, costing one short model
call, and in testing it was steered into the turn already in flight rather than queued behind
it. The loop is not interrupted — the running turn finishes and its continuation is sent
normally — but the judge's view of that turn now includes the status exchange.

You rarely need this mid-loop. Every continuation already prints its own
`↻ [continuing toward your standing goal — turn N/M]` line, so live state is in the
transcript. Reach for `/goal status` when the loop is paused or finished, when you want the
full goal text and the last judge reason, or to confirm a pause landed.

`/goal pause` takes effect immediately even mid-turn: no further continuation is injected.
Pressing <kbd>esc</kbd> also stops the loop, because an interrupted turn pauses the goal.

### Completion contracts

A vague goal can only be judged vaguely. Give the judge a bar to clear. Any line starting with
a known field prefix is lifted out of the goal text; everything else is the objective.

```
/goal Port the auth service from session cookies to JWT
verify: pytest tests/auth passes
constraints: keep the /login response shape unchanged
scope: only services/auth and its tests
stop when: a database schema migration is required
```

| Prefix | Meaning |
| --- | --- |
| `outcome:` | The single end state that must be true when done. |
| `verify:` / `verified by:` / `verification:` | The command, test, or artifact that proves it. |
| `constraints:` / `preserve:` | What must not change or regress. |
| `scope:` / `boundaries:` | Which files, directories, or systems are in scope. |
| `stop when:` | The condition under which the agent should stop and ask. |

Only these exact prefixes are recognised, so an ordinary goal containing a colon
(`Fix bug: the parser drops commas`) is left alone.

## How the loop stops

The point of this plugin is that it terminates. Five conditions, checked in order:

| # | Condition | Kind |
| --- | --- | --- |
| 1 | Judge returns `done` — the reply carries concrete evidence, such as a passing command and its output | model |
| 2 | Judge returns `blocked` — impossible, out of scope, needs credentials or hardware you do not have, or the agent is going in circles | model |
| 3 | **Stall** — `stallLimit` consecutive turns ran no tools at all, so nothing changed however confident the prose | deterministic |
| 4 | **Repetition** — the agent produced the same reply twice running | deterministic |
| 5 | **Budget** — `maxTurns` continuation turns spent (21 executions by default) | deterministic |

Conditions 3–5 do not consult the model. This is deliberate: in testing, a weak judge model
answered `continue` to twenty byte-identical replies and happily spent the entire budget. The
deterministic guards are what actually stopped it, in two turns and about $0.004 instead of
twenty turns and roughly $0.02. Treat the judge's `blocked` verdict as a useful fourth opinion,
not as the safety net.

## Caveats

- **The judge is only as good as its model.** A weak judge is permissive. Set `judgeModel` to
  something small and sharp, and expect to use `/goal status` to sanity-check its verdicts.
- **Your agent model must actually use tools.** If the session model narrates intentions
  without calling tools, the stall guard fires after two turns. That is the guard working, but
  it means the goal will not get done.
- **Status messages cost a model call.** A synthetic session message is a real prompt in
  OpenCode, so this plugin does not emit one per iteration — loop progress is shown in the
  continuation prompt (`↻ [continuing toward your standing goal — turn 3/20]`) and a message is
  only sent when the loop actually stops.
- **A stalled or paused goal is not deleted.** Use `/goal clear` to drop it.
- The plugin runs once per OpenCode location. Only the instance owning a session's directory
  reacts to its turns, so a global install does not double-drive any one session.

## Attribution

The design follows the **Ralph loop**: keep a goal alive across turns and do not stop until it
is achieved. That idea comes from the `/goal` command in
[Codex CLI](https://github.com/openai/codex) by Eric Traut, and a very similar feature ships in
[Hermes](https://github.com/) as `/goal`, whose command surface, completion-contract framing and
judge verdicts this plugin deliberately mirrors. This is an independent implementation against
OpenCode's V2 plugin API; no code was copied from either project.

## Layout

| File | Runs in | Role |
| --- | --- | --- |
| `index.ts` | OpenCode server | The loop itself, plus the RPC the TUI reads. |
| `rpc.ts` | shared | The contract between the two halves. |
| `tui.ts` | TUI | Discovered entrypoint; re-exports the panel. |
| `tui.tsx` | TUI | The panel, the summary lines, the toasts and dialogs. JSX needs the `.tsx` extension. |
| `display.ts` | TUI | Which placements are on, as pure functions. |
| `display.test.ts` | TUI | Checks for the above. Plain node, no test framework. |

## Development

```sh
git clone https://github.com/zignd/opencode-goal-plugin.git
cd opencode-goal-plugin
npm install
npx tsc -p tsconfig.json
node display.test.ts
```

Bumping support for a new OpenCode release means bumping `@opencode/plugin` and re-running the
typecheck. `tsconfig.json` carries `jsxImportSource: "@opentui/solid"`, which is what makes the
panel's JSX typecheck.

Two notes for anyone hacking on it:

- RPC schemas must be `as const`. Annotating them as a wider JSON Schema type stops the
  definition being assignable to `PortableDefinition`, and `register` rejects it.
- `session.synthetic` is a real prompt that costs a model call. Never use it per iteration.

## License

MIT — see [LICENSE](LICENSE).
