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
  lines to a goal so the judge knows what "done" actually means instead of guessing. A field
  may be a fence when it needs more than one paragraph. `verify-cmd:` is a cheap re-read the
  plugin actually runs.
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
        "pollLimit": 3,
        "judgeModel": { "providerID": "openrouter", "id": "google/gemini-3-flash-preview" }
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `maxTurns` | `20` | Automatic continuation turns before the loop auto-pauses. A whole number, or `"unlimited"` / `null` for no ceiling. The initial `/goal` turn is not counted, so `20` allows 21 agent executions in total. See below. |
| `stallLimit` | `2` | Consecutive turns that ran **no tools** before the loop is declared stalled. |
| `pollLimit` | `3` | Consecutive turns that re-read an unchanged result before the loop is called polling. Distinct from `stallLimit`: a polling turn *does* use tools, it just learns nothing. |
| `judgeModel` | session model | Model used for the `done` / `continue` / `blocked` verdict. |
| `quiet` | `false` | Stop posting the loop's turn banner and completion notices into the transcript while the panel is open. |
| `verifyTimeoutMs` | `120000` | Timeout for one `verify-cmd` re-read. Capped at 5 minutes. A five-gate is the wrong command for this field. |

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

### Session settings

Four settings, each with a default in the plugin options and an override for the current
session. The override applies at once, including to a goal that is already running, and lasts
until the session ends — it never rewrites your config.

| Subcommand | Option | Notes |
| --- | --- | --- |
| `/goal budget <n\|inf\|default>` | `maxTurns` | See [Removing the turn limit](#removing-the-turn-limit) |
| `/goal stall <n\|default>` | `stallLimit` | Turns with **no tool calls** before giving up |
| `/goal poll <n\|default>` | `pollLimit` | Turns reading the **same unchanged result** before calling it polling |
| `/goal quiet <on\|off\|default>` | `quiet` | When on, the panel replaces the loop's transcript notices |
| `/goal judge <provider/model[#variant]\|default>` | `judgeModel` | Cheaper and sharper models judge better and cost less |
| `/goal settings` | — | Shows all four, and whether each is a session override or the config default |

### What a subcommand reply costs

A synthetic session message is a real prompt: it starts an execution and costs a model call, and
the agent then repeats the confirmation back at you. For a one-line "stall limit is now 5" that
is pure waste.

So the settings subcommands answer through the TUI as a toast when one is attached, and fall back
to the transcript only when there is no TUI to show it — desktop, the web client,
`opencode run`. `/goal settings` uses a dialog the same way, and `/goal panel` and
`/goal display` already worked this way.

| Subcommand | Reply |
| --- | --- |
| `/goal stall`, `/goal quiet`, `/goal judge`, `/goal budget <n>` | toast, no model call |
| `/goal settings` | dialog, no model call |
| `/goal panel`, `/goal display` | toast, no model call |
| `/goal status`, `/goal pause`, `/goal resume`, `/goal clear` | in the transcript, a model call each |

The last row is deliberate. Those are direct answers to something you typed, and `/goal status`
returning nothing is exactly the bug this table's siblings were built to avoid — a silent command
reads as a broken one. They also print more than fits in a toast. Set `quiet: true` if the
transcript notices are the part you want gone, though that covers the loop's own reporting rather
than these replies.

`/goal settings` opens a dialog in the TUI and prints to the transcript elsewhere:

```text
Turn budget   20   (config default)
Stall limit   5 turns with no tools   (this session)
Quiet mode    on   (this session)
Judge model   openrouter/perceptron/perceptron-mk1.5   (this session)
```

A model is written `provider/model`, and the model half may itself contain slashes —
`openrouter/perceptron/perceptron-mk1.5` is valid. `#variant` selects a variant if the model
has one.

### Removing the turn limit

The budget is the loop's hard ceiling on cost and wall-clock time. You can lift it per session:

```text
/goal budget inf         no turn limit
/goal budget 60          a specific limit
/goal budget default     back to the configured maxTurns
/goal budget             report the current one
```

`inf` is the short spelling. `unlim`, `unlimited`, `unbounded`, `infinite`, `inf.`, `none`,
`no-limit` and `∞` all work too.

It applies to the running goal immediately and to every goal set afterwards in that session.
`maxTurns: "unlimited"` in the plugin options does the same thing as the default.

**What you give up.** With no ceiling, the only things that stop the loop are:

| Still stops it | |
| --- | --- |
| The judge says `done` | the goal is met, with evidence |
| The judge says `blocked` | the goal is unreachable, on goal-level evidence |
| Stall guard | `stallLimit` consecutive turns with no tool calls |
| Polling guard | `pollLimit` consecutive turns with an unchanged result |
| Repetition guard | the same reply twice running |
| Polling guard | 3 turns that re-read an unchanged result |
| You | `/goal pause`, `/goal clear`, or <kbd>esc</kbd> |

So an agent that keeps making small, genuine-looking progress can now run indefinitely. Nothing
caps total spend. If you want a middle ground, `/goal budget 500` gives most of the headroom
with a real ceiling. The panel shows `turn 7/∞` and says so explicitly while unlimited.

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
| `/goal budget` | Report this session's turn budget. |
| `/goal budget <n>` | Set a turn budget for this session, applied at once if a goal is running. |
| `/goal budget unlimited` | No turn limit. |
| `/goal budget default` | Back to the configured `maxTurns`. |
| `/goal stall <n>` | Turns with no tool calls before the loop gives up. |
| `/goal quiet <on\|off>` | Whether the panel replaces the loop's transcript notices. |
| `/goal judge <model>` | `provider/model[#variant]` used to judge each turn. |
| `/goal settings` | Every setting and where its value came from. |

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

### Choosing where the goal is shown

`/goal display` opens a picker listing the four placements with their current state. Picking
one toggles **only that one**; *hide everywhere* clears them all.

The picker closes on the first pick, so name several at once on the command line for anything
non-trivial. Comma or space separated, with an optional trailing `on`/`off`:

```text
/goal display panel,composer          toggle each of those three
/goal display panel,composer on       turn both on, leave the rest alone
/goal display footer,sidebar off      turn both off, leave the rest alone
```

A change appears immediately, without reopening anything.

That took a fix worth recording, because the cause was not obvious from the symptom.
`context.storage.store` is durable but **not reactive**, and a slot's `render` runs once, so
`<Show when={display.panel}>` read a snapshot of the placements and never re-read it. The
visible effect was that a placement change only appeared after something forced the slot to
re-render — in practice, toggling the panel with `/goal panel`, which is exactly the manual
workaround that should not be needed.

So the stored value is mirrored into a signal, which is the mechanism the goal state already
used and which demonstrably re-renders in this host. The store stays the single durable
record; the signal is only what the UI reads, and it leads the write so a change shows on
the frame it happens rather than after the storage round trip. Because the UI shows four
placements but only ever changes the named one, `applyMutation` returns the **whole** value
rather than the keys that changed — otherwise an untouched placement would silently revert on
the next write. Both properties are pinned in `test/display.test.ts`.

With an explicit `on`/`off` the named placements are set and the rest untouched; without one,
each named placement toggles.

> **This is a native picker on purpose.** A custom checkbox dialog was built — focusable box,
> hand-drawn checkmarks, a keymap layer — and abandoned. In this host a plugin keymap layer does
> not receive keys while a plugin dialog is open, so it rendered perfectly and ignored every
> keypress. It was traced across three variants (registered from `setup`, then from a component
> gated on `target`, then gated on `enabled`); in all three the handlers never ran once, while
> the host's own dialogs worked throughout. The host's dialogs manage their own input, so they
> are the ones to use. A multi-select dialog would need host support for plugin input in dialogs.

The selection logic lives in `display.ts` as pure functions with checks in `display.test.ts`,
because it could only otherwise be verified by clicking through the dialog — and the first
version of it silently switched every other placement off when you picked one.

> Editing `index.ts`, `rpc.ts` or `display.ts` hot-reloads. Editing `tui.tsx` does **not** —
> restart the TUI to pick it up, because the discovered `tui.ts` entrypoint is what gets
> watched.

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
a known field prefix is lifted out of the goal text; everything else is the objective. A field
that needs a blank line is a fence. The info string is the field name. A fence whose info
string is not a known field is left in the headline, so a goal that quotes a code block is
not mangled.

```
/goal Port the auth service from session cookies to JWT
verify: pytest tests/auth passes
constraints: keep the /login response shape unchanged
scope: only services/auth and its tests
stop when: a database schema migration is required
```

~~~~
/goal Close the remaining Phase 20 items
```verify
bash scripts/track-plan.sh shows Phase 20 strictly above 72

the last five-gate log is green
```
verify-cmd: grep -q "exit 0" build/five-gate.log
~~~~

`verify:` is a description the judge reads. `verify-cmd:` is a command the plugin runs, and
only after a first judge pass returns `done`. The second pass sees the exit code and the
output, and may demote `done` to `continue`. It does not re-run the proof. A five-gate takes
about ten minutes and holds a lock; the field is a cheap re-read of a log the agent already
wrote (`grep`, `tail`, `track-plan.sh`). The default timeout is 120 seconds, which is enough
for that re-read and too short for a gate. A command that would exceed it is the wrong
command. Several `verify-cmd:` lines, or several fences, are several commands, run in order.

| Prefix | Meaning |
| --- | --- |
| `outcome:` | The single end state that must be true when done. |
| `verify:` / `verified by:` / `verification:` | The command, test, or artifact that proves it. A description, not a command the plugin runs. |
| `verify-cmd:` / `verified by running:` | A cheap re-read the plugin runs after a first-pass `done`. Not a five-gate. |
| `constraints:` / `preserve:` | What must not change or regress. |
| `scope:` / `boundaries:` | Which files, directories, or systems are in scope. |
| `stop when:` | The condition under which the agent should call `goal_blocked`. |

Only these exact prefixes are recognised, so an ordinary goal containing a colon
(`Fix bug: the parser drops commas`) is left alone. The one-line form still works: a non-blank
continuation line stays in the field, and a blank line ends it.

## Writing a goal in a fresh session

Installing the plugin puts the tools on the turn, not the contract. Two things cover that:

- The `goal-contract` skill. Its description is on the skill list every turn, and the agent loads the body when you ask for a goal. The body is `skills/goal-contract.md`, and a test checks it names every field the parser accepts.
- `/draft-goal <outcome>`. It does not depend on the agent choosing the skill: it submits a prompt that carries the contract and asks for the `/goal` text, without starting the work.

## Tools the agent can call

The agent does not read this plugin. It learns a tool from the description on the tool list,
plus one line in the continuation prompt while a goal is looping. A description that only
says what the tool returns will sit unused. The tools stay registered when no goal is active
and answer with a sentence; hiding them between turns is worse than a no-op.

| Tool | Call it instead of | Waits on |
| --- | --- | --- |
| `goal_wait` | replying with a status update while something you started is still running | — |
| `goal_blocked` | saying in prose that the goal cannot be finished as written | nothing; a reason pauses immediately |
| `goal_pending` | guessing which background jobs are still running | the waiter seeing child sessions, not only shells |
| `goal_evidence` | leaving a proof only in the reply | the evidence digest |

`goal_blocked` requires a reason. It pauses the loop, and the next judge pass does not
override that pause. `/goal resume` still does, and `/goal status` shows the reason so the
resume is a choice. Naming a blocker in the reply does not pause anything.

`goal_pending` returns unfinished `sh_*` and `ses_*` ids and nothing else. `goal_evidence`
appends a command, an exit code, and a capped output to the digest. Filing evidence does not
finish the goal. There is no `goal_done`: the judge, plus `verify-cmd` when one was set, is
the only path that finishes a goal. The plugin does not copy the shell, the file tools, or
the subagent tool.

## How the loop stops

The point of this plugin is that it terminates. Six conditions, checked in order:

| # | Condition | Kind |
| --- | --- | --- |
| 1 | Judge returns `done` — the reply carries concrete evidence, or the digest plus a `verify-cmd` that just passed | model |
| 2 | Judge returns `blocked` — impossible, out of scope, needs credentials or hardware you do not have | model |
| 3 | **Stall** — `stallLimit` consecutive turns ran no tools at all, so nothing changed however confident the prose | deterministic |
| 4 | **Repetition** — the agent produced the same reply twice running | deterministic |
| 5 | **Polling** — `pollLimit` consecutive turns ran tools and read back the same unchanged result | deterministic |
| 6 | **Budget** — `maxTurns` continuation turns spent (21 executions by default) | deterministic |

Conditions 3–6 do not consult the model. This is deliberate: in testing, a weak judge model
answered `continue` to twenty byte-identical replies and happily spent the entire budget. The
deterministic guards are what actually stopped it, in two turns and about $0.004 instead of
twenty turns and roughly $0.02. Treat the judge's `blocked` verdict as a useful fourth opinion,
not as the safety net.

### `blocked` means the goal, not the turn

The one rule worth stating on its own, because getting it wrong stops work that would have
finished. An earlier version told the judge to answer `blocked` when "the loop is going in
circles". That mapped a **turn-level** observation onto a **goal-level** verdict, and the
failure mode was concrete: an agent waiting on a five-minute build spends each turn reading
an unchanged log, and the judge — seeing a turn that changed nothing — declared the whole
goal unachievable and paused. The work was not unachievable; the agent was waiting.

So repetition is now explicitly **not** a reason to answer `blocked`, however many turns it
has happened, because repetition is recoverable: the next turn can do something different. A
turn that checks on work already in flight is **waiting**, not circling, and the judge is told
so. The digest and the pending-id list are the off-screen record. Anything not in the reply,
the digest, or that list did not happen.

### The polling guard

The stall and repetition guards miss a specific shape. An agent waiting on a long job says
something different every turn (so the reply digest moves) and calls a tool every turn (so
the tool count is non-zero), while learning nothing. Only the model noticed, and it reached
for the terminal verdict.

So the loop also digests **what the tool calls reported**, ignoring the commands that
produced them, and pauses after `pollLimit` turns whose observation is unchanged. Its message
says the work is not moving, says to wait for a running command rather than re-read it, and
says plainly that this is not a statement about whether the goal is reachable.

`pollLimit` is configurable exactly like `stallLimit` — `pollLimit` in `opencode.json`, or
`/goal poll <n|default>` for the session — because the right threshold is a property of the
work: a build that takes five minutes wants a higher limit than a test that takes five
seconds, and a hardcoded 3 was the one number here a user could not argue with.

It fails open: an unrecognised tool-state shape yields an empty digest and the guard stays
quiet, because a heuristic that pauses a loop on a guess is worse than one that misses.

## Caveats

- **The judge is only as good as its model.** A weak judge is permissive. Set `judgeModel` to
  something small and sharp, and expect to use `/goal status` to sanity-check its verdicts.
- **A `blocked` verdict is worth reading twice.** It means the goal looks unreachable, which
  is a strong claim resting on one model call. If the agent was mid-way through a long
  command, a large batch, or a build, the more likely story is that it was waiting and the
  judge read a quiet turn as a dead end. `/goal resume` costs nothing but the turn.
- **Your agent model must actually use tools.** If the session model narrates intentions
  without calling tools, the stall guard fires after two turns. That is the guard working, but
  it means the goal will not get done.
- **Status messages cost a model call.** A synthetic session message is a real prompt in
  OpenCode, so this plugin does not emit one per iteration — loop progress is shown in the
  continuation prompt (`↻ [continuing toward your standing goal — turn 3/20]`) and a message is
  only sent when the loop actually stops.
- **A stalled or paused goal is not deleted.** Use `/goal clear` to drop it.
- **An unanswered permission prompt is a host stall.** The plugin does not turn `ask` into `allow`.
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
| `index.ts` | OpenCode server | Discovered entrypoint; re-exports `src/server.ts`. |
| `tui.ts` | TUI | Discovered entrypoint; re-exports `src/tui.tsx`. |
| `src/server.ts` | OpenCode server | The loop, the `/goal` command, and the RPC the TUI reads. |
| `src/tui.tsx` | TUI | The panel, the summary lines, the toasts and dialogs. |
| `src/rpc.ts` | shared | The contract between the two halves, and the `/goal help` text. |
| `src/budget.ts` | server | Turn budget: parsing, the exhaustion gate, formatting. |
| `src/display.ts` | TUI | Which placements are shown, `/goal display` argument parsing. |
| `src/settings.ts` | server | The other three settings, override resolution, `/goal settings`. |
| `test/*.test.ts` | — | Checks for the three pure modules. |

`index.ts` and `tui.ts` have to stay at the root: OpenCode discovers a plugin by looking for
those two names in the plugin directory, and ignores a `src/` layout for discovery. They are
thin entrypoints, and everything they serve lives under `src/`. `tui.ts` exists separately from
`tui.tsx` because JSX needs the `.tsx` extension to compile.

## Development

```sh
git clone https://github.com/zignd/opencode-goal-plugin.git
cd opencode-goal-plugin
npm install

npm test              # the whole suite
npm run check         # typecheck, then the suite — what CI runs
npm run typecheck     # tsc alone
npm run test:watch    # re-run on change
npm run test:coverage # line, branch and function coverage
```

The suite runs on Node's built-in test runner, so there is no test dependency to install.
`node --test` discovers `*.test.ts` and strips the types, which is why the checks import
`./settings.ts` while the plugin source imports `./settings.js` — the plugin needs `.js`
specifiers for OpenCode's own loader. Where a module is imported by both, the import is
`import type`, which is erased and so has no runtime cost.

Current state: 140 checks over three modules, at 100% line, branch and function coverage.

| Module | What it covers |
| --- | --- |
| `budget.ts` | Turn-budget parsing, the exhaustion gate, formatting, the `maxTurns` option |
| `display.ts` | Which placements are shown, `/goal display` argument parsing |
| `settings.ts` | The other three settings, override resolution, the `/goal settings` summary |

`index.ts` and `tui.tsx` are not unit tested: they are mostly wiring, and the parts that
historically broke were extracted into the three pure modules precisely so they could be.
`npm run check` typechecks both.

Bumping support for a new OpenCode release means bumping `@opencode/plugin` and re-running the
typecheck. `tsconfig.json` carries `jsxImportSource: "@opentui/solid"`, which is what makes the
panel's JSX typecheck.

Two notes for anyone hacking on it:

- RPC schemas must be `as const`. Annotating them as a wider JSON Schema type stops the
  definition being assignable to `PortableDefinition`, and `register` rejects it.
- `session.synthetic` is a real prompt that costs a model call. Never use it per iteration.

## License

MIT — see [LICENSE](LICENSE).
