# Verified recovery engineering progress

## Task status

Last updated: November 23, 2026.

| Task | Status | Remaining work |
| --- | --- | --- |
| 1. Real Kane verification | Done, run for real | Real pass, real confirmed product bug and a real `checkpoint create --verify kane` handoff on kane-cli 0.10.8. The parser uses Kane's structured verdict; tests include scrubbed recordings. Evidence packs are referenced by path, not sealed or copied. |
| 2. Completion gate | Done | `gate run --start --url` starts the app from the fingerprinted tree, refuses an occupied port, points Kane at it, runs `--check` regression commands, and reports `verified` only if the app stayed alive and nothing changed. Spec, `--protect` files and objective are locked. See `docs/completion-gate.md`. |
| 3. Cross-agent recovery | Done | `recover run` with rotating fallback agents (Codex, Claude Code), persistent signed recovery records and failure-aware briefings built from Kane's verdict. |
| 4. Automatic repair and recheck | Done | Headless agent runs (no sandbox or permission bypass), app restart from the new tree, Kane and regression rerun, `--max-attempts` limit. |
| 5. Security and reliability | Done for this scope | Project lock with dead-owner takeover, HMAC-signed gate and recovery state, locked spec and protected files, fenced untrusted Kane output, process-tree shutdown, local-only app URLs, objective origin check, security tests. Not a boundary against a hostile same-user process. |
| 6. Report and real demo | Done | `recover report` timeline. Real run: Kane failed → Codex crashed (model config) → Kane failed → Claude Code fixed → Kane passed, **verified** (`docs/launch/recovery-demo.md`). Planned order was Claude → Kane → Codex → Kane; the real run went Kane → Codex → Kane → Claude → Kane. |
| 7. Comparative benchmarks | First run published | Four groups, hidden Kane objective, one repetition with Claude Code: all four verified, so this task does not discriminate. Needs harder tasks, more repetitions, and Codex once its model config is fixed. See `packages/benchmarks/README.md`. |
| 8. Submission preparation | Drafted | `docs/launch/submission.md`. Owner actions: confirm eligibility with organizers, fix the Codex model setting, record the demo, submit. |

## Facts to keep straight

- The repository's first commit is dated November 11, 2026, before the stated November 12 cutoff. Organizer approval is needed before treating this codebase, or the Kane extension built on it, as eligible. Do not rewrite history or present old code as new.
- `~/.codex/config.toml` on the development machine sets `model = "gpt-5.4"`, which Codex rejects for a ChatGPT login; that is why Codex failed in the demo and was left out of the benchmark.
- Claude Code was found bundled in the VS Code extension (2.1.330), not on PATH.

## Design decisions and limitations

Kane documents `run_end` as the completion event and typeless failed progress records. Real 0.10.8 output also carries a `reason_code` and a `verdict` on failure, which Relayvora uses but does not depend on; a failure Kane blames on itself or leaves unconfirmed is `unknown`, not a defect. Kane's session files and evidence packs remain under Kane's control and may contain sensitive information; Relayvora never records Kane's shareable `test_url`. The fingerprint excludes ignored files, dependencies, environment and external services, so `verified` is evidence for the supplied objective and checks against the app Relayvora started, not proof of everything a task requires.
