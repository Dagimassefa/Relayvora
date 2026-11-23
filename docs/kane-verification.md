# Browser verification with Kane CLI

Relayvora can run Kane CLI during a checkpoint and carry its result into the handoff. Install `@testmuai/kane-cli` and sign in using Kane's setup instructions first. Start the application separately and make sure its URL is reachable from the machine running Kane.

```sh
relayvora handoff --from claude --to codex --verify kane --kane-objective "Open http://localhost:3000, save an item, and verify it appears in the list"
```

Relayvora runs `kane-cli run <objective> --agent`, parses Kane's completion event and failed step remarks, and records the result and a redacted excerpt in the handoff. A pass requires both a passing `run_end` and exit code zero; missing, inconsistent, truncated or infrastructure-error results are unknown. Kane may provide a session location or evidence-pack hint; Relayvora records the hint but does not copy the evidence pack. The receiving agent can use a failure to investigate and fix the application. After the fix, run `relayvora report <checkpoint-id> --reverify` to run the recorded command again and compare the results. Commands from imported checkpoints cannot be rerun; explicitly choose the checks in a new local checkpoint instead.

You can repeat `--verify` to include other checks, and use `--verify-timeout` to adjust the per-command timeout in seconds. Kane uses its own browser, authentication, network and credit configuration; Relayvora does not start the app, authenticate Kane, or automatically fix failures. Use a specific objective with observable expected behavior and avoid putting secrets in the objective or browser output, which may be recorded in the handoff.

The integration supports a demonstration of the test–handoff–fix–retest loop; it does not by itself establish hackathon eligibility. Confirm the repository and submission rules with the organizers.

Kane's one-shot output does not guarantee individual structured assertions or expected/observed values; Relayvora preserves the failed remarks Kane actually reports and does not invent them. The checkpoint is not a completion gate: it does not prove that a running server matches the checked-out source, protect acceptance criteria, or automatically repair and reverify the task.
