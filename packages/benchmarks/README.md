# AgentRelay benchmark

Does handing a task to a fresh session through AgentRelay save tokens or money compared with continuing
the same session? `run.mjs` measures it on matched two-step tasks:

- **Step A** builds up a session (small: a calculator; large: read a 43-file, ~58k-token codebase and document it).
- **Step B** is the follow-up (small: an expression parser; large: discount codes touching two files), done either
  - **normal**: in the same session (`claude -p --resume`), or
  - **relay**: in a fresh session started from an AgentRelay handoff (`checkpoint create --verify auto`, launch prompt).
- Each arm does its own step A in its own copy of the task. Quality is scored with **hidden tests** the agents never see.
- Usage and cost come from Claude Code's own JSON output.

```sh
node run.mjs --tasks small-calculator,large-inventory --reps 2   # spends real usage
node run.mjs --rescore results/<file>.json                         # re-score a saved run, free
```

**Accounting trap (fixed):** with `--resume`, Claude Code's `total_cost_usd` and `modelUsage` are cumulative for the
whole session while `usage` covers only the new call. The harness subtracts step A's cost and records a `costCheck`
per run. An earlier one-off comparison that missed this wrongly showed the relay winning on the small task.

## Results (2026-10-10, Claude Code 2.1.295, Opus)

| | Small: normal | Small: relay | Large: normal | Large: relay |
| --- | --- | --- | --- | --- |
| Runs per arm | 2 | 2 | 1 | 1 |
| Context per call at handoff | 40k | 40k | 160k | 163k |
| **Step B cost** | **$0.127** | **$0.221 (+73%)** | **$0.306** | **$0.308 (+1%)** |
| Step B input tokens | 148k | 187k (+26%) | 819k | **327k (-60%)** |
| Step B avg context per call | 42k | 42k | 164k | **47k (-71%)** |
| Step B model calls | 3.5 | 4.5 | 5 | 7 |
| Step B time | 30s | 29s | 42s | 37s |
| Hidden tests passed | 96% | 100% | 100% | 100% |

Prices fitted from these runs (fit within 1%): cache read ~$0.20/M tokens, cache write ~$8.13/M, output ~$19/M.

## What it means

- **Small sessions: relaying costs more** (+73% on the next step). Nothing to save, and a fresh session pays to
  write its starting context into the cache and to get oriented.
- **Large sessions: relaying cuts tokens sharply** (-60% input, -71% context per call), **but not dollars on a short
  follow-up**: the old session's context is re-read from cache at ~$0.20/M, while the fresh session pays a one-time
  cache write (~21k tokens, ~$0.17) plus two orientation calls. Estimated dollar break-even: **~9 calls** into the new
  session, after which every call is ~$0.023 cheaper.
- **Not measured yet, but likely the biggest win:** when the old session's cache has gone cold (you hit a usage limit
  and came back later, which is the main reason to relay), continuing means re-writing ~164k tokens at the cache-write
  price (~$1.30 at these prices) against ~$0.17 for the relay. A "cold resume" benchmark is the next one to run.
- Quality was equal or slightly better through the relay (hidden tests 100% vs 96%); n is small.

Caveats: 1-2 runs per arm, one model, non-interactive mode. Treat these as directional, not definitive.
