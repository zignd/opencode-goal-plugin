## Writing a /goal

A `/goal` is a standing goal. After each turn a judge decides whether it is done. The first line is the objective. Known prefixes are the contract the judge holds the work to. Anything else is the objective.

```
/goal Port the auth service from session cookies to JWT
verify: pytest tests/auth passes
constraints: keep the /login response shape unchanged
scope: only services/auth and its tests
stop when: a database schema migration is required
```

### Fields

- `outcome:` the end state that must be true when done.
- `verify:` / `verified by:` / `verification:` the proof, as a description the judge reads. It is prose. The plugin does not run it.
- `verify-cmd:` / `verified by running:` a command the plugin runs after the judge first says done. Several lines are several commands, run in order.
- `constraints:` / `preserve:` what must not change.
- `scope:` / `boundaries:` what is in scope.
- `stop when:` when the agent should call `goal_blocked` with a reason.

Only these exact prefixes count, so `Fix bug: the parser drops commas` is left alone.

### A field that needs a blank line

Use a fence. The info string is the field name. Blank lines inside stay in the field. A fence with any other info string is left in the objective, and an unclosed fence is not a field.

````
/goal Close the remaining items
```verify
track-plan.sh shows the count above 72

the last gate log is green
```
verify-cmd: grep -q "exit 0" build/gate.log
````

### Rules that are easy to get wrong

- `verify-cmd:` re-reads a log the agent already wrote (`grep`, `tail`, a tracker script). It never re-runs the proof. A test suite or a ten-minute gate belongs in the reply, because running it again races the agent and can demote a real pass. The timeout is 120 seconds.
- Write the proof as something checkable: a command and the output it must print, a file that must exist, a count that must be reached. "Works well" cannot be judged.
- `stop when:` is for a real stop, such as a missing tool or a decision only the user can make. The agent ends it by calling `goal_blocked`. Naming a blocker in the reply does not pause the loop.
- Do not tell the agent to copy the goal into a child session, and do not mention a `goal_done` tool. There is none. Only the judge, plus `verify-cmd`, finishes a goal.

### What to hand back

When asked to draft a goal, return only the `/goal` text in one code block, then one line naming anything you had to assume. Do not start the work.
