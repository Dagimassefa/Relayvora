# Completion gate

The gate answers one question: did an independent browser check pass against an app built from exactly this source? It runs Kane CLI against an app that Relayvora itself starts, runs your regression checks, and fails closed on anything it cannot establish.

From a Git project with Kane installed and signed in (stop any server already using the port):

```sh
relayvora gate run --spec task.md \
  --objective "Open http://localhost:3000, save an item, and verify it remains after refresh" \
  --start "node server.mjs" --url http://localhost:3000/ \
  --check "npm test" --protect test/app.test.js
relayvora gate status
```

## States

| State | Meaning | Exit code |
| --- | --- | --- |
| `verified` | Kane passed against the app Relayvora started from the fingerprinted tree, every `--check` passed, the app process stayed alive, and nothing changed during the run. | 0 |
| `recovery_required` | Kane confirmed an application defect, or a regression check failed. | 1 |
| `blocked` | Something could not be established: no `--start`/`--url`, the app did not start, the port was already in use, the app exited mid-run, Kane was inconclusive or blamed itself, or a check timed out. | 1 |
| `stale` | Source, specification or protected files changed during or after the run. | 1 |

## How the runtime is bound to the source

1. Relayvora fingerprints HEAD, the index, and the contents of tracked and non-ignored untracked files; the spec and each `--protect` file are fingerprinted separately.
2. It refuses to start if anything already listens on `--url`, so a stale server cannot answer.
3. It starts `--start` (no shell) in the project root with `PORT` set, and waits until the URL answers.
4. Kane runs with `--url` pointed at that app. URLs in the objective must have the same origin.
5. Regression checks run against the same tree.
6. It stops the app's whole process tree and fingerprints again. Only an unchanged fingerprint and an app process that stayed alive throughout allow `verified`.

## Locked acceptance criteria

The first run locks the spec, the protected files and the objective. Later runs refuse to proceed if any changed: start a new task (remove the gate state) instead of editing the baseline. Gate state is HMAC-signed with a per-user key in Relayvora's data directory; edited state is rejected, and `gate status` always recomputes fingerprints. One gate or recovery runs per project at a time (a lock left by a dead process is taken over).

## Limits

- The fingerprint does not cover ignored files (build output, `node_modules`), dependencies, environment variables, databases or external services. Use a `--start` command that runs or builds from source; a start command that serves a stale ignored build can pass.
- The signing key and state are readable by the same OS user, so an agent running as that user could forge them. The gate is an integrity check against accidents and naive edits, not a security boundary against a hostile local process.
- `verified` is evidence of the objective and checks you supplied, not of requirements they do not cover.
- Relayvora records Kane's evidence-pack path but does not copy or seal the pack.

See [Kane verification](kane-verification.md) for result parsing and [recovery](recovery.md) for automatic repair.
