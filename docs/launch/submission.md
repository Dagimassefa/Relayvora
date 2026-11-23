# Submission draft: Relayvora verified recovery

## Before submitting (owner actions)

- [ ] **Eligibility.** Relayvora's first commit is dated November 11, 2026, before the stated November 12 cutoff. Ask the organizers whether a Kane extension built on an existing codebase is eligible, and keep their answer. Do not rewrite history or present the existing code as new. Everything Kane-related was written on or after November 20, 2026 (see `git log -- apps/cli/src/kane.ts apps/cli/src/completion-gate.ts apps/cli/src/recovery.ts`).
- [ ] **Demo video.** Record `relayvora recover run` on `fixtures/demo-app` (script below), ideally with the Kane browser visible.
- [ ] **Codex model.** `~/.codex/config.toml` sets `model = "gpt-5.4"`, which Codex rejects on a ChatGPT login; set a supported model before recording so Codex can take part.
- [ ] Merge `feat/kane-verification`, and publish a release if the rules require an installable build.

## Short description

AI coding agents often say "done" when the app is not. Relayvora turns a task into a verified result: it starts your app from the exact source on disk, has Kane CLI test it in a real browser, and when Kane confirms a bug it hands Kane's findings to another coding agent (Codex or Claude Code), restarts the app from the fix, and checks again. It reports **verified** only when Kane passed against the app it started from unchanged source, regression checks passed, and the acceptance spec and protected tests were not touched.

## What is built

- `--verify kane` in checkpoints and handoffs, with a parser built from real kane-cli 0.10.8 output, including its structured verdict (`reason_code`, fault family, bug, root cause, suggestion).
- `relayvora gate run`: a fail-closed completion gate with a Relayvora-managed runtime, source fingerprints, locked spec and protected files, regression checks, a project lock and signed state.
- `relayvora recover run|status|report`: a cross-agent recovery loop with rotation, retry limits, failure-aware briefings that fence untrusted Kane output, and a timeline report.
- A four-group benchmark harness (`packages/benchmarks/recovery.mjs`) scored on a hidden Kane objective.

## Evidence

- [Real recovery report](recovery-demo.md): Kane failed (missing Delete button) → Codex crashed (model configuration) → Kane still failing → Claude Code fixed it → Kane passed, regression passed, **verified**, in 308 s.
- Real Kane pass/fail recordings: `apps/cli/test/fixtures/kane-real-*.ndjson`.
- Benchmark results: `packages/benchmarks/results/recovery-*.json` and [the benchmark README](../../packages/benchmarks/README.md#verified-recovery-benchmark).

## Demo script

```sh
# terminal 1: nothing else may listen on the port
git clone <repo> && cd Relayvora && pnpm install && pnpm build
npm install -g @testmuai/kane-cli && kane-cli login --oauth
mkdir ../demo && cp fixtures/demo-app/server.mjs fixtures/demo-app/task/* ../demo && cd ../demo
git init -q && git add . && git commit -qm start
node ../Relayvora/apps/cli/dist/bin.js recover run --spec spec.md --protect regression.test.mjs \
  --objective "Open http://localhost:3100/, save an item named bread, then delete bread using its Delete button, refresh the page, and verify bread is no longer in the list" \
  --start "node server.mjs" --url http://localhost:3100/ --check "node --test regression.test.mjs" --agents codex,claude
node ../Relayvora/apps/cli/dist/bin.js recover report
```

## Honest limits

- `verified` covers the objective and checks supplied. Ignored files, dependencies, environment and external services are outside the fingerprint.
- Signed state protects against accidental and naive edits, not against a hostile process running as the same user.
- Kane's verdict fields are not a documented contract; Relayvora falls back to status and exit code when they are absent.
- Evidence packs are referenced by path, not copied or sealed.
- The benchmark has very few repetitions so far; treat its numbers as a demonstration, not a statistical result.
