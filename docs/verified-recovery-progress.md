# Verified recovery engineering progress

## Task status

Last updated: November 23, 2026.

| Task | Status | Remaining work |
| --- | --- | --- |
| 1. Real Kane verification | Built and run for real | Done on kane-cli 0.10.8 against `fixtures/demo-app`: a real pass, a real confirmed product bug, and a real `checkpoint create --verify kane` handoff. Parser tests include scrubbed recordings of those runs. Open: evidence packs are referenced by path, not sealed or copied. |
| 2. Completion gate | Prototype built | Bind the running application to the fingerprinted source, protect acceptance definitions from tampering, and enforce the gate in the recovery workflow. The prototype cannot mark a task verified. |
| 3. Cross-agent recovery | Not built | Add a controller, fallback selection, persistent recovery state, and failure-aware briefing. |
| 4. Automatic repair and recheck | Not built | Launch the fallback agent, refresh the app, rerun Kane and regression checks, and enforce retry limits. |
| 5. Security and reliability | Started | Imported checkpoint commands are blocked from re-execution; the recovery workflow still needs locks, stronger evidence protection, and security testing. |
| 6. Report and real demo | Not built | Produce a recovery timeline and demonstrate Claude → Kane → Codex → Kane with real executions. |
| 7. Comparative benchmarks | Not built | Run the four comparison groups and publish actual results and methodology. |
| 8. Submission preparation | Not complete | Confirm eligibility, complete documentation, record the demo, and prepare the submission. |

The immediate priority is runtime-to-source verification so the gate can safely establish verified completion. Kane is installed and authenticated on the development machine; Claude CLI was not on PATH when last checked. The repository predates the hackathon's stated November 12 cutoff; organizer confirmation is needed before relying on a new extension that depends on Relayvora.

## Implemented

- Existing checkpoint, Git evidence, handoff and agent launch flows remain in use.
- `--verify kane --kane-objective` invokes Kane's one-shot agent mode and includes its observed result in a handoff.
- A Kane pass requires a consistent terminal event and exit status. Missing, truncated, contradictory and infrastructure-error output is unknown. Failed step remarks and available session/evidence hints are included in the redacted excerpt.
- Existing `report --reverify` repeats local commands and compares outcomes. Commands from imported checkpoints are rejected even with confirmation.
- Experimental `gate run` and `gate status` record a Kane result and check fingerprints of the repository and acceptance specification. The gate never reports verified because runtime-to-source binding is not implemented. See `docs/completion-gate.md` for scope and limitations.

## Not yet implemented or demonstrated

- Enforced completion across the recovery workflow, runtime freshness, tamper-resistant acceptance criteria, structured evidence packs, durable recovery state and bounded automatic agent repair.
- The comparative benchmark, recovery report and real Claude-to-Codex demonstration described in the engineering note.
- Real Kane browser runs have been made (November 23, 2026); no real cross-agent recovery has been made or claimed yet.
- The existing repository's first commit is dated November 11, 2026. Organizer approval is needed before treating this old codebase or a new extension depending on it as eligible. Do not rewrite history or present old code as new.

## Design decisions and limitations

Kane documents `run_end` as the completion event and typeless failed progress records. Real 0.10.8 output also carries a `reason_code` and a `verdict` on failure, which Relayvora uses but does not depend on; step remarks and verdicts are Kane's observations, not independent assertion objects. Output excerpts are redacted, but Kane's own session files and evidence packs remain under Kane's control and may contain sensitive information. A passing command is evidence of that browser run, not verified completion of a recovery task or proof that a server used the current source.
