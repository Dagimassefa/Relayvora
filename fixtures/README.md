# Fixtures

Synthetic agent session files used by adapter tests. They mimic the **observed** on-disk layouts of
Claude Code and Codex CLI; they are not copies of real sessions and contain no user data.

- `claude/projects/<encoded cwd>/<session id>.jsonl`: Claude Code transcript layout (`CLAUDE_CONFIG_DIR`).
- `claude/projects/-work-demo/corrupted.jsonl`: unparseable header, must produce a warning, not a crash.
- `codex/sessions/YYYY/MM/DD/rollout-*.jsonl`: Codex CLI layout (`CODEX_HOME`), current
  `session_meta` format and a legacy format without `cwd`.

When a vendor changes its format, add a new fixture next to the old one rather than editing it.
