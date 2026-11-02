# Changelog

## 0.1.0-alpha.3

- Hand work over between machines: `relayvora export --out handoff.json` on one, `relayvora import handoff.json`
  in a clone on the other. The checkpoint is re-pointed at the local clone, keeps edits made to the handoff file, and
  the import says when the base commit has not been pushed. `export --with-changes` also carries uncommitted work as a
  patch (sensitive files left out, secrets refused), applied with `import --apply-changes` on the same commit.
- `export` defaults to the latest checkpoint and picks JSON for a `.json` file.
- Share through the repository, with your Git host login as the account: `relayvora sync` gives every device the
  full checkpoint history, `relayvora send --to <email>` sends one to a teammate, and `relayvora inbox` shows what
  was sent to you. Everything lives on a `relayvora/handoffs` branch, written without touching your working tree.

## 0.1.0-alpha.2

- Automatic checkpoints for OpenCode: `relayvora hooks install` adds a plugin that saves a checkpoint when a turn
  fails on a usage or rate limit, after compaction, and at the end of turns (throttled).
- The home screen shows when a newer version is on npm (checked at most once a day; `RELAYVORA_NO_UPDATE_CHECK=1`
  turns it off).
- The npm build no longer prints Node's `ExperimentalWarning` about SQLite on every command.

## 0.1.0-alpha.1

- OpenCode support: sessions, prompts, the last agent report, per-call context, usage, cost, rate limits and
  compactions are read from OpenCode's SQLite database (read-only), and `--to opencode` launches `opencode --prompt`.

## 0.1.0-alpha.0

- Local Claude Code/Codex session discovery and evidence-backed handoffs, including editor-extension sessions.
- Git changes and session commits, automatic verification, budgeted handoffs, redaction and audited launches.
- Relay reports, terminal home screen, relay radar and watch alerts.
- Automatic checkpoints from Claude Code hooks and Codex notify, with throttling and per-session pruning.
- Enforced project checkpoint retention, explicit delete/prune commands, previews and confirmation.
- Warm/cold benchmark scenarios for Claude Code and Codex, three task sizes and configurable repetitions.
- Standalone npm tarball packaging, checksums, offline installation smoke tests and signed GitHub build attestations in the release workflow.

The VS Code extension is planned for version two. Cold-resume and Codex benchmark results still require live runs; existing published measurements remain the original Claude Code runs.
