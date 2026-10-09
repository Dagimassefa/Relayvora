# Architecture overview

```
apps/cli ──► packages/core ◄── packages/storage
   │              ▲   ▲
   ├──────────────┘   ├── packages/git
   └──► adapters ─────┘   (adapter-claude, adapter-codex)
```

`core` has no dependency on any other workspace package. Everything else depends on `core`.
The CLI is the only package that wires adapters, storage and Git together. A future VS Code
extension should call the same command functions (`runInit`, `runDoctor`, `runSessions`) or the
CLI's `--json` output, and contain no business logic of its own.

## Key decisions

| Decision | Why |
| --- | --- |
| `node:sqlite` instead of `better-sqlite3` | No native build step, so installs work the same on Windows, macOS and Linux. Requires Node 22.13+. The CLI suppresses its ExperimentalWarning. |
| Migrations tracked by `PRAGMA user_version`, applied in one `BEGIN IMMEDIATE` transaction | A failed migration leaves the database untouched. A newer DB is refused rather than corrupted. |
| WAL + `busy_timeout` | Several CLI invocations can share the store. |
| `runCommand` uses argument arrays with `shell: false` | No quoting bugs and no injection. Windows `.cmd` shims, which Node will not spawn without a shell, go through `cmd.exe /d /s /c` with every argument quoted, and any argument containing `% ! ^ & \| < > "` is refused. |
| Git commands use `GIT_OPTIONAL_LOCKS=0` | Reading status must never take `index.lock` while an agent is committing. |
| Adapters label capabilities `documented` / `best-effort` / `unsupported` | Session files on disk are observed formats, not vendor APIs. Discovery is `best-effort` and tolerates unknown records; it never writes vendor files. |
| JSONL is read head-only, streamed, with oversized lines skipped | Transcripts reach tens of MB, and a single line can hold hundreds of KB of pasted images. |

## Checkpoint provenance rules (schema 0.1)

Enforced by `packages/core/src/checkpoint.ts`:

- Every fact is labelled `observed`, `agent-reported`, `inferred` or `user-provided`.
- `observed` facts must cite at least one evidence id, and every cited id must exist.
- Evidence with `status: "passed"` requires a `command` and `exitCode: 0`. `failed` requires a command and a
  non-zero exit code. Anything else must be `unknown` or `not-run`. Captured artifacts (diffs, files,
  transcripts) use `recorded`, which makes no claim about correctness.

## Checkpoint pipeline (Phase 2)

```
session file ──adapter.readTranscript──► TranscriptDigest ┐
git working tree ──collectGitSnapshot──► GitSnapshot      ├─► buildCheckpoint ─► renderHandoff ─► store + .agentrelay/handoffs/<id>.md
--verify commands ──runVerification────► VerificationResult┘     (core, pure)     (core, pure)
```

- **Collect** (I/O): adapters, `@agentrelay/git` and the CLI service gather inputs. Transcripts are streamed
  with a raw-line prefilter, so a 30 MB rollout costs one pass and parses only the relevant records.
- **Build** (`core/build.ts`): converts inputs into evidence and labelled facts, applies per-item caps, and
  redacts everything. Failing commands become `[observed]` blockers; passing ones become `[observed]` completions.
- **Render** (`core/handoff.ts`): §7.2 selection. The floor is required items plus a reference to everything
  else. Optional items are added greedily by tier (failure → changed → related). The assembled text is then
  checked against the budget, evicting the lowest-priority items first, and a final fill pass spends any slack.
  More than five deferrals collapse into one line per kind, since paths are already in the Changed files table.
  Output is deterministic for a given checkpoint and budget.
- Token counts are estimates (chars/4) and are labelled as such. Session usage comes from the agent's own
  records (`cost-state` for Claude Code, cumulative `token_count` events for Codex) and is labelled `provider-reported`.
