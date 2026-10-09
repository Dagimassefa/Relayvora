# AgentRelay

Move unfinished work between AI coding agents (Claude Code ⇄ Codex CLI) with a compact,
evidence-backed checkpoint instead of replaying a long transcript.

> **Status: pre-alpha.** Session discovery, checkpoints and handoff previews work. Launching the target
> agent (Phase 3) and benchmarking (Phase 4) are not built yet. No token-saving claims are made until they
> are measured (see the blueprint's §11).

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`; no native compilation)
- Git 2.31+
- pnpm 10 (for development)

## Quick start (from source)

```sh
pnpm install
pnpm build
node apps/cli/dist/bin.js doctor
```

To get an `agentrelay` command, run `pnpm --filter @agentrelay/cli link --global` (or just call `pnpm agentrelay <command>`).

## Commands (implemented)

| Command | What it does |
| --- | --- |
| `agentrelay init` | Registers the current project (Git root) and creates `.agentrelay/` with its own `.gitignore`. Idempotent. |
| `agentrelay doctor` | Checks Node, platform/WSL, Git, the local store, the project, and each agent adapter. |
| `agentrelay sessions [-p claude\|codex] [--all] [-n 20]` | Lists local agent sessions for this project, newest first. Read-only. |
| `agentrelay checkpoint create [options]` | Captures task state, Git evidence and verification results; writes a handoff preview. |
| `agentrelay checkpoint list` / `show <id>` | Lists checkpoints; prints the handoff Markdown (`--format json` for everything, `--budget` to re-render). |
| `agentrelay handoff --to <provider> [options]` | Same as `checkpoint create`, then prints the handoff. `--confirm` (launch) is not available yet. |
| `agentrelay export <id> [--out file] [--format json]` | Exports a checkpoint, re-redacted. Writing a file asks for confirmation (`--yes` to skip); never overwrites without `--force`. |
| `agentrelay config show` | Shows resolved data directory, database path and project config. |

### Checkpoint options

```sh
agentrelay handoff --from codex --to claude \
  --goal "Fix leap-year handling" \
  --constraint "Keep the public API" --pending "Handle years divisible by 400" \
  --verify "pnpm test" --budget 4000
```

- `--from <provider>` uses the newest session of that agent recorded in this project; `--session <id>` picks one
  (prefix ok). With neither, the checkpoint is built from the repository and your flags only (recovery mode).
- `--goal`, `--constraint`, `--done`, `--pending`, `--blocker`, `--decision` (repeatable) are recorded as **user** facts.
  Without `--goal`, the session's first prompt is used and labelled **inferred**.
- `--verify "<cmd>"` (repeatable) runs the command **without a shell** and records its real exit code. This is the
  only way a checkpoint will say something passes. Pipes and redirects are rejected; wrap them in a script.
- `--budget <tokens>` caps the handoff text (estimated tokens, default from `.agentrelay/config.json`).

### What a handoff contains

Repository state, goal, latest user requests, constraints, blockers, remaining work, verification evidence
and changed files are always included. Failing command output, then diffs, then new-file contents are added
in that order while they fit the budget; the rest is listed under *Deferred context* with the exact command
to fetch it. Every fact is labelled `[observed]`, `[user]`, `[agent-reported]` or `[inferred]`. Secrets are
redacted before anything is stored, and `.env`/key files are never captured. The preview is written to
`.agentrelay/handoffs/<id>.md` so you can review and edit it.

Global flags: `--json` (machine-readable output), `-C/--cwd <dir>`, `-v/--verbose`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Failure |
| 2 | Usage error (bad flag, unknown provider) |
| 3 | Not found |
| 4 | Unsupported (e.g. `handoff --confirm` before Phase 3) |
| 5 | Cancelled |
| 6 | Precondition failed (e.g. `doctor` found a blocking problem, not a Git repo) |

## Where data lives

- **Global store**: SQLite at `%LOCALAPPDATA%\agentrelay` (Windows), `~/Library/Application Support/agentrelay`
  (macOS), `$XDG_DATA_HOME/agentrelay` or `~/.local/share/agentrelay` (Linux). Override with `AGENTRELAY_HOME`.
- **Per project**: `.agentrelay/config.json`, ignored by Git through `.agentrelay/.gitignore`.
- Agent sessions are read from `CLAUDE_CONFIG_DIR` (default `~/.claude`) and `CODEX_HOME` (default `~/.codex`).
  AgentRelay never writes to these directories.

Nothing is uploaded anywhere. There is no telemetry.

## Repository layout

```
apps/cli/                  agentrelay command (commander)
packages/core/             checkpoint schema (zod), redaction, token estimates, platform + safe subprocess, adapter contract
packages/storage/          SQLite store (node:sqlite), versioned migrations
packages/git/              read-only Git evidence: repo root, HEAD, branch, porcelain status, worktrees
packages/adapter-claude/   Claude Code discovery
packages/adapter-codex/    Codex CLI discovery
fixtures/                  synthetic session files for adapter tests
docs/                      architecture and security notes
```

## Development

```sh
pnpm test        # vitest, runs against source (no build needed)
pnpm build       # tsc -b, project references
pnpm typecheck
```

CI runs build, tests and a CLI smoke test on Windows, macOS and Linux with Node 22 and 24.

## Roadmap (V0.1)

- [x] Phase 1: monorepo, CLI foundation, `init`/`doctor`/`sessions`/`config`, SQLite + migrations, safe subprocess
- [x] Checkpoint schema v0.1 with provenance rules; redaction pipeline
- [x] Phase 2: Git diff evidence, transcript digests, `--verify` evidence, `checkpoint create/list/show`, budgeted Markdown handoff, `export`
- [ ] Phase 3: `handoff --preview/--confirm` launching the target agent via documented CLI input
- [ ] Phase 4: usage capture, benchmark harness, signed releases
