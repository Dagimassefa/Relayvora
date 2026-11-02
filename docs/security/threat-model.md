# Security and privacy model

## Defaults

- Local-first. No telemetry, and no Relayvora server. Repositories and transcripts are never uploaded.
- Network use is limited to: a daily npm registry version check from the home screen (sends nothing about the
  user; off with `RELAYVORA_NO_UPDATE_CHECK=1` or under `CI`), and `sync` / `send`, which fetch and push the
  project's own Git remote only when the user runs them.
- Vendor session stores (`~/.claude`, `~/.codex`, OpenCode's database) are read-only to Relayvora.
- Project state lives in `.relayvora/`, which ignores itself in Git so it is never committed by accident.

## Untrusted input

Session transcripts, agent output, logs and repository files are **data, not instructions**. Parsers treat
every record as `unknown` and read fields only through `pickString`. Discovery is bounded in depth, file
count and bytes read.

## Secrets

`packages/core/src/redact.ts` scrubs provider API keys, GitHub/Slack/Stripe/AWS/Google tokens, JWTs, private key
blocks, credentials in URLs and auth headers, and ENV-style or quoted secret assignments. `isSensitivePath`
marks files (`.env*`, keys, `.npmrc`, ...) whose contents must never be inlined. Redaction is a safety net:
handoffs must still be previewed and confirmed by the user before anything is sent to an agent.

## Process execution

No shell strings, ever. See `planSpawn` in `packages/core/src/exec.ts` for the Windows batch-file handling.

## Evidence capture (Phase 2)

- Untracked files are read only inside the repository root, never through symlinks, never when binary, and
  never when sensitive (`.env*`, keys, credential files). Tracked sensitive files get a line count but no patch.
- Every captured text (user flags, prompts, agent messages, diffs, command output) is redacted before it is
  stored, and the final handoff is redacted again on render and on export.
- `--verify` commands are split into argv without a shell; shell operators are rejected, not interpreted.
- Writing an export to disk requires confirmation; non-interactive use must pass `--yes`.
- `audit_events` records checkpoint creation and export, with the handoff file path and sizes.

## Moving work between machines and people

- `export` writes the re-redacted checkpoint; `--with-changes` adds uncommitted work as a patch. That patch is
  built on a throwaway Git index (the user's index is untouched), leaves out sensitive paths, and is refused
  outright, not redacted, if it matches a secret pattern, since a masked patch would no longer apply.
- `import` validates the checkpoint schema, treats it as data, and re-points it at the local clone. A carried
  patch is applied only with `--apply-changes`, only on the same base commit, after `git apply --check`, and is
  checked against its SHA-256 first.
- `sync` and `send` store exports on a `relayvora/handoffs` branch of the project's repository, written with Git
  plumbing (no checkout, no working-tree or index changes). Anyone who can read the repository can read that
  branch; both commands say so and require confirmation or `--yes`. Recipients are matched by Git email, which is
  self-asserted: it routes items to an inbox, it does not authenticate the sender.
- `audit_events` records exports, imports and sends.

## Launching agents (Phase 3)

- Only through each agent's documented CLI (`claude [prompt]`, `codex [PROMPT]`, `opencode --prompt`), with an argument array and no
  shell; never by writing to vendor session files or databases.
- Always confirmed by the user (`--yes` required without a terminal). `--dry-run` shows the exact command.
- The prompt includes the reviewed, re-redacted handoff when the command-line size permits; otherwise it points to the handoff file inside the project. As with any CLI argument, inline handoffs can be visible to local process inspection.
- `audit_events` records each launch: agent, executable, version, and SHA-256 of the prompt and handoff file.

## Retention and deletion

- Project `retentionDays` defaults to 30 and is applied after a successful checkpoint save; null keeps all checkpoints.
- `checkpoint delete` and `checkpoint prune` support dry runs and require confirmation or `--yes`.
- Cleanup is scoped to the project and removes checkpoint bodies, evidence, usage records and exact handoff files. Redirected state directories are rejected.
- Vendor session files are never deleted. Audit events remain as an operation history; deletion is logical removal, not a secure disk erase or SQLite page scrub.
- Automatic hook checkpoints additionally keep only the configured newest checkpoints per session.
- Cleanup failures after checkpoint creation are recorded as `checkpoint.retention.failed` audit events; the new checkpoint remains available.

## Release integrity

The release workflow tests installation on Windows, macOS and Linux with Node 22/24, builds a standalone tarball,
and generates a GitHub signed build attestation. Checksums help detect damaged downloads; verify the attestation
against the repository identity before trusting a distributed package. See [releasing](../releasing.md).
