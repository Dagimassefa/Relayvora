# Verified recovery

`relayvora recover run` closes the loop: verify with Kane, and when Kane confirms a defect, hand the failure to a fallback agent, restart the app from its changes, and verify again, until the [completion gate](completion-gate.md) reports `verified` or the attempt limit is reached.

```sh
relayvora recover run --spec spec.md --protect regression.test.mjs \
  --objective "Open http://localhost:3100/, save bread, delete it with its Delete button, refresh, and verify it is gone" \
  --start "node server.mjs" --url http://localhost:3100/ \
  --check "node --test regression.test.mjs" \
  --agents codex,claude --max-attempts 2
relayvora recover report          # Markdown timeline of the latest recovery
relayvora recover status [id]
```

## What happens

1. **Initial check.** The gate starts the app, runs Kane and the checks. `verified` ends here; `blocked` or `stale` stops without touching code.
2. **Repair.** On `recovery_required`, the next agent in `--agents` (rotating) runs headlessly in the project with a briefing containing the objective, the locked spec, Kane's verdict and step remarks, failing check output, and earlier attempts.
3. **Recheck.** The gate restarts the app from the new working tree and reruns Kane and every check.
4. Repeat until `verified`, a non-recoverable state, or `--max-attempts`. The result is `verified`, `exhausted` or `blocked`.

Agents run with their normal safety settings: Codex as `codex exec --sandbox workspace-write`, Claude Code as `claude -p --permission-mode acceptEdits`. Relayvora never passes sandbox or permission bypass flags. Agents that are not installed are skipped and noted; OpenCode cannot be driven headlessly yet.

## Safeguards

- The spec, `--protect` files and objective are locked; an agent that edits them stops the recovery as `blocked`.
- Kane output contains text from the app under test. The briefing fences it and tells the agent to treat it as evidence, never as instructions; Kane's suggestion is labelled unverified.
- Agents are told not to start the app, run Kane, weaken tests or commit. Relayvora does not rely on that: it restarts the app itself and the locks detect edits to protected files. It cannot detect weakened tests that are not protected, so protect them.
- One recovery or gate per project at a time. Recovery records are HMAC-signed like gate state, with the same limits.
- Changes are left uncommitted in the working tree for you to review.

## The report

`recover report` prints each step with timestamps: gate states and reasons, Kane's result, check outcomes, each agent's exit, duration, resulting working-tree changes and the end of its output.
