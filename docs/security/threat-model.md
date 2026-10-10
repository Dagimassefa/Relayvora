# Security and privacy model

## Defaults

- Local-first. No network calls and no telemetry. Repositories and transcripts are never uploaded.
- Vendor session directories (`~/.claude`, `~/.codex`) are read-only to AgentRelay.
- Project state lives in `.agentrelay/`, which ignores itself in Git so it is never committed by accident.

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

## Launching agents (Phase 3)

- Only through each agent's documented CLI (`claude [prompt]`, `codex [PROMPT]`), with an argument array and no
  shell; never by writing to vendor session files or databases.
- Always confirmed by the user (`--yes` required without a terminal). `--dry-run` shows the exact command.
- The prompt is a fixed pointer to the handoff file inside the project; no transcript text is put on a command line.
- `audit_events` records each launch: agent, executable, version, and SHA-256 of the prompt and handoff file.

## Open items before alpha

- Retention and delete commands (`retentionDays` exists in config but is not enforced yet).
