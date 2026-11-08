# Changelog

## 0.1.0-alpha.5

Security release for [GHSA-pw6w-429w-v39w](https://github.com/Dagimassefa/Relayvora/security/advisories/GHSA-pw6w-429w-v39w).
Everyone who shares checkpoints (`sync`, `send`, `inbox`, `import`, or the MCP server) should upgrade.
Reported by Corey Klass.

- Shared checkpoints can no longer write outside `.relayvora/handoffs`. Checkpoint ids must be a single safe file
  name, must match their file name on the `relayvora/handoffs` branch, and are checked before anything is written.
  A checkpoint that fails is skipped and listed as "Not imported".
- `report --reverify` shows the exact commands of an imported checkpoint and asks before running them; without a
  terminal it refuses unless you pass `--yes`.
- Imported checkpoints are marked as imported. `[observed]` claims from the sender become agent-reported, the handoff
  says it was not verified here, and the inbox shows senders as unverified.
- A carried patch must change exactly the files it lists, or the import is refused.
- MCP: `get_handoff` is read-only and no longer imports (use `import_checkpoint`); `inbox` is no longer marked
  read-only, `import_checkpoint` is marked destructive, and `project` must be inside the server's start directory.
- Suggested `git diff` commands single-quote file names.
- Imported handoffs and patches are written with owner-only permissions, and retention no longer stops at an invalid id.

## 0.1.0-alpha.4

- `relayvora mcp`: an MCP server on stdio. Any MCP-capable agent (Cursor, Copilot, Windsurf, Claude Code, Codex...)
  can fetch handoffs, save checkpoints with its own goal, steps and blockers, list checkpoints, check the inbox and
  import shared checkpoints, including agents Relayvora has no adapter for. It never pushes or runs commands.
- `--help` lists OpenCode wherever an agent is named.

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
