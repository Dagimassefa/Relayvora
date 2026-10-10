# AgentRelay

Move unfinished work between AI coding agents (Claude Code ⇄ Codex) with a compact, evidence-backed handoff
instead of replaying a long transcript.

When an agent hits a usage limit, gets stuck, or its session has grown huge, AgentRelay reads that session,
captures the real state of your repository (uncommitted changes, commits made during the session, test results),
writes a short handoff that labels what is verified and what is not, and starts the next agent with it.

> **Status: pre-alpha.** Works end to end on Windows, macOS and Linux with the Claude Code and Codex CLIs or their
> VS Code / Cursor extensions. Measured honestly: it saves **tokens and context** on large sessions, **not money on
> small ones**. See [Does it save anything?](#does-it-save-anything).

## Quick start

Requirements: Node.js **22.13+**, Git 2.31+, and pnpm 10 to build from source.

```sh
pnpm install
pnpm build
cd apps/cli && npm link        # global `agentrelay` command; `pnpm build` picks up later changes
agentrelay doctor              # checks Node, Git, the store, and finds Claude Code / Codex
```

Then, in any project where you have used Claude Code or Codex:

```sh
agentrelay                                                        # home screen
agentrelay handoff --from codex --to claude --verify auto --confirm
```

That finds your latest Codex session for the project, runs the project's own checks, builds the handoff, shows a
summary card, and (after you confirm) starts Claude Code in this terminal with the handoff loaded. Remove the global
command with `npm unlink -g @agentrelay/cli`.

## How a relay works

1. **Read the session.** Your goal (the latest substantial request, or `--goal`), your recent requests and the
   agent's last report come from the session transcript. Injected context and IDE wrappers are stripped.
2. **Capture evidence.** Uncommitted diffs and new files, plus the commits you made since the session started.
   `.env` files, keys and binaries are never read; secrets in everything else are redacted before storage.
3. **Verify.** `--verify auto` runs the project's own typecheck/lint/test commands without a shell and records real
   exit codes. A checkpoint only says something passes if a command actually passed.
4. **Build the handoff** within a token budget (4,000 by default): goal, requests, blockers, test results and changed
   files always; failing output, then diffs, then new files while they fit; everything else as a "fetch this if
   needed" line. Every fact is labelled `[observed]`, `[user]`, `[agent-reported]` or `[inferred]`.
5. **Launch** the target agent with the handoff, or copy it for an editor panel.
6. **Measure** afterwards with `agentrelay report`.

## Does it save anything?

Measured with the benchmark harness in [`packages/benchmarks`](packages/benchmarks/README.md): the same two-step
task done by continuing one session versus relaying to a fresh one, scored by hidden tests (Claude Code, Opus,
1-2 runs per arm, so directional rather than definitive).

| Next step after the switch | Small session (40k tok/call) | Large session (160k tok/call) |
| --- | --- | --- |
| Cost: continue vs relay | $0.127 vs $0.221 (**+73%**) | $0.306 vs $0.308 (**about even**) |
| Input tokens | +26% | **-60%** |
| Context per call | about the same | **-71%** (164k → 47k) |
| Hidden tests passed | 96% vs 100% | 100% vs 100% |

- **Small sessions: don't relay to save money.** A fresh session pays to set up its cache and get oriented.
- **Large sessions: big token and context savings**, but dollars only break even after **~10 calls** in the new
  session, because re-reading a warm cache is cheap (~$0.20/M tokens) and writing a new one is not (~$8/M).
- **Likely the biggest win, not yet benchmarked:** relaying after a break (you hit a limit and came back later).
  The old session's cache has expired by then, so continuing it means re-writing its whole context.
- Relay when you **hit a limit, want to switch agents, or a big session has gone cold or has a lot of work left**.

### Knowing when to relay

AgentRelay works this out for you from each agent's own session records, and shows it on the home screen's
**relay radar**, the checkpoint card's **WORTH** row, and as live alerts from `agentrelay watch`:

| Signal | How it is detected | Verdict |
| --- | --- | --- |
| Usage limit hit | Claude Code: `rate_limit` API error ("You've hit your session limit · resets ..."); Codex: limit error or `rate_limit_reached_type` | relay now |
| Near a limit | Codex reports used % of its 5-hour and weekly windows; 90% or more | relay soon |
| Large session gone cold | Idle over an hour (Claude Code caches for 1 hour, measured) and 60k+ tokens per call | relay: continuing re-processes everything at full price |
| Compacted | Claude Code summarised the conversation because it grew too large | relay |
| Small, warm session | Under ~60k tokens per call, recently active | continue |

```sh
agentrelay watch --bell        # in a spare terminal; Ctrl+C to stop
```

## Commands

| Command | What it does |
| --- | --- |
| `agentrelay` | Home screen: project, sessions, **relay radar**, last relay, stats, suggested commands. Read-only. |
| `agentrelay watch [--interval 60] [--bell]` | Alerts the moment a relay pays off: an agent hit or nears its limit, or a large session went cold. |
| `agentrelay doctor` | Checks Node, platform/WSL, Git, the store, the project, and each agent (PATH or editor extension). |
| `agentrelay init` | Registers the project (Git root) and creates `.agentrelay/`, which ignores itself in Git. |
| `agentrelay sessions [-p claude\|codex] [--all]` | Lists agent sessions for this project, newest first. Read-only. |
| `agentrelay handoff --to <agent> [options]` | Creates a checkpoint and shows the card; `--confirm` launches the agent. |
| `agentrelay checkpoint create [options]` | Same capture as `handoff`, without the launch options. |
| `agentrelay checkpoint list` / `show <id>` | Lists checkpoints; prints a handoff (`--budget` re-renders it, `--format json`). |
| `agentrelay launch <id> [--to <agent>]` | Starts the agent with an existing, possibly edited, handoff. |
| `agentrelay report [id] [--reverify]` | Measures a relay: the session that continued it, context per call, onboarding, checks. |
| `agentrelay export <id> [--out file]` | Exports a checkpoint, re-redacted. Asks before writing; never overwrites without `--force`. |
| `agentrelay config show` | Shows the data directory, database path and project config. |

Global flags: `--json` (machine-readable), `-C/--cwd <dir>`, `-v/--verbose`, `--no-color`.

### Handoff and checkpoint options

```sh
agentrelay handoff --from codex --to claude \
  --goal "Fix leap-year handling" --constraint "Keep the public API" --pending "Handle years divisible by 400" \
  --verify auto --budget 4000 --confirm
```

| Option | Meaning |
| --- | --- |
| `--from <agent>` / `--session <id>` | Newest session of that agent in this project, or a specific one (id prefix is fine). Neither: build from the repository and your flags only. |
| `--goal`, `--constraint`, `--done`, `--pending`, `--blocker`, `--decision` | Your own facts, labelled `[user]`; the last five are repeatable. |
| `--verify "<cmd>"` / `--verify auto` | Run a check without a shell and record its exit code. `auto` finds `typecheck`, `lint`, `test` in `package.json` (right package manager), `ruff`/`pytest`, `go vet`/`go test`, `cargo test`, or a Makefile `test` target. |
| `--commits-since 2h` / `--no-commits` | Window for commits included as completed work (default: the session start), or leave them out. |
| `--budget <tokens>` | Size cap for the handoff text (estimated tokens). |
| `--copy` | Copy the handoff to the clipboard for an editor panel. |
| `--confirm`, `-y`, `--dry-run`, `--print` | Launch the agent; skip the question; show the exact command only; print the full handoff text. |
| `--no-transcript` | Do not read the session transcript. |

### Launching

AgentRelay starts the agent's interactive session in your terminal, in the project folder, through its documented
command line (`claude [prompt]`, `codex [PROMPT]`). It uses the CLI on PATH, otherwise the copy bundled in your editor
extension. Just before launching it re-checks the repository against the checkpoint; if nothing changed, the agent is
told it can skip re-checking. The handoff file as it is on disk, including your edits, goes into the first message
when the command line allows, otherwise a short pointer to the file. It always asks first (`--yes` for scripts), and
every launch is recorded in the audit log with hashes of what was sent.

### VS Code, Cursor and other editors

No global install is needed. The Claude Code and Codex extensions write sessions to `~/.claude` and `~/.codex` and
ship their own CLI, which AgentRelay finds in VS Code, VS Code Insiders, Cursor, Windsurf, VSCodium and VS Code Server.
To continue in an editor panel instead of a terminal, add `--copy` and paste, or tell the agent the one-line message
the card prints (`Continue the task described in .agentrelay/handoffs/<id>.md ...`).

### Measuring a relay

```sh
agentrelay report --reverify
```

`report` finds the session that continued a checkpoint (started after it, with a prompt mentioning its id, whether
launched or pasted) and shows, from the agents' own usage records: turns, duration, tokens and cost of that session,
**context per call** before and after the relay, **onboarding** (calls and tokens before its first edit), a token
payback estimate, and with `--reverify` whether the checkpoint's checks pass now. Results are summarised on the home
screen.

## Terminal output

Colour adapts to the terminal and turns off when output is piped, with `--json`, `--no-color` or `NO_COLOR`
(`FORCE_COLOR=1..3` forces it on; `AGENTRELAY_ASCII=1` avoids Unicode block characters). Progress and the summary card
go to stderr, so `agentrelay handoff ... > handoff.md` captures only the Markdown.

| Exit code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Failure |
| 2 | Usage error (bad flag, unknown agent, missing goal) |
| 3 | Not found (no session, no checkpoint, agent not installed) |
| 4 | Unsupported |
| 5 | Cancelled |
| 6 | Precondition failed (confirmation needed without a terminal, `doctor` found a blocking problem) |

## Privacy and data

- **Local only.** Nothing is uploaded and there is no telemetry.
- **Global store:** SQLite at `%LOCALAPPDATA%\agentrelay` (Windows), `~/Library/Application Support/agentrelay`
  (macOS), `$XDG_DATA_HOME/agentrelay` or `~/.local/share/agentrelay` (Linux). Override with `AGENTRELAY_HOME`.
- **Per project:** `.agentrelay/` (config and handoff files), ignored by Git through its own `.gitignore`.
- **Agent sessions** are read from `CLAUDE_CONFIG_DIR` (default `~/.claude`) and `CODEX_HOME` (default `~/.codex`) and
  never written to. Session formats are not documented by the vendors, so reading them is best-effort.

More in [docs/security/threat-model.md](docs/security/threat-model.md) and
[docs/architecture/overview.md](docs/architecture/overview.md).

## Repository layout

```
apps/cli/                  the agentrelay command: commands, launch, report, terminal UI
packages/core/             checkpoint schema, handoff builder and renderer, redaction, check detection, safe subprocess
packages/storage/          SQLite store (node:sqlite) with versioned migrations
packages/git/              read-only Git evidence: status, diffs, untracked files, session commits
packages/adapter-claude/   Claude Code: session discovery, transcript reading, launch
packages/adapter-codex/    Codex: session discovery, transcript reading, launch
packages/benchmarks/       normal-vs-relay benchmark harness, tasks, hidden tests and results
fixtures/                  synthetic session files for adapter tests
docs/                      architecture and security notes
```

## Development

```sh
pnpm test        # vitest against source, no build needed (180 tests)
pnpm build       # tsc -b with project references
node packages/benchmarks/run.mjs --tasks small-calculator --reps 2   # benchmark (spends real agent usage)
```

CI runs the build, the tests and a CLI smoke test on Windows, macOS and Linux with Node 22 and 24.

## Roadmap

- [x] CLI foundation: `init`, `doctor`, `sessions`, SQLite store, safe subprocesses, cross-platform paths
- [x] Checkpoints: Git and commit evidence, transcript digests, `--verify` / `--verify auto`, budgeted handoffs, `export`
- [x] Launching: `handoff --confirm` and `launch`, via the CLI or the editor-extension copy, with a freshness check
- [x] Measurement: `report`, onboarding and payback, home-screen stats
- [x] Benchmark harness with small and large tasks and hidden-test scoring
- [ ] "Cold resume" benchmark (switching after the old session's cache has expired), more tasks and runs, Codex arms
- [ ] VS Code extension, retention and delete commands, signed releases
