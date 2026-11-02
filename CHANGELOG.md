# Changelog

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
