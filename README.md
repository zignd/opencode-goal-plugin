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
| `maxTurns` | `20` | Continuation turns before the loop auto-pauses. |
| `stallLimit` | `2` | Consecutive turns that ran **no tools** before the loop is declared stalled. |
| `judgeModel` | session model | Model used for the `done` / `continue` / `blocked` verdict. |

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
| 5 | **Budget** — `maxTurns` continuations spent | deterministic |

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

## Development

```sh
git clone https://github.com/zignd/opencode-goal-plugin.git
cd opencode-goal-plugin
npm install
npx tsc --noEmit --strict --skipLibCheck --module preserve \
  --moduleResolution bundler --target es2022 --lib es2023 --types node index.ts
```

`index.ts` is the whole plugin. Bumping support for a new OpenCode release means bumping the
`@opencode/plugin` dependency and re-running the typecheck above.

## License

MIT — see [LICENSE](LICENSE).
