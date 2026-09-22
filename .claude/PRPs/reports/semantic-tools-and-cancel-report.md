# Implementation Report: Semantic Tools and Cancellation (Goal Doc Phase 4)

## Summary
Four new MCP tools — `local_analyze`, `local_implement`, `local_review`, `local_cancel` — on top of the Phase 3 modes, with `run_local_agent` kept as the free-form fallback. Running jobs are now abortable: `local_cancel(job_id)`, a per-job wall clock (`AGENT_JOB_TIMEOUT_SECONDS`, default 900, `timeout_seconds` per call) and a client disconnect all abort the in-flight Ollama request and kill the shell subprocess; the job returns the steps it has (and the partial diff in implement mode) with `status cancelled` / `status timed_out` in the header. All job tools take `worker`, `model`, `max_iterations`, `timeout_seconds`.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium-Large | Medium-Large |
| Confidence | 8/10 | Single pass; one long-standing test-harness bug found and fixed |
| Files Changed | 12 (2 new) | 18 (2 new) — every test file touched |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 0 | Branch + baseline | Complete | 225 tests |
| 1 | Abort through `chatWithOllama` | Complete | Abort reason passes through unwrapped |
| 2 | Abort kills the shell subprocess | Complete | Shares the timer's process-group kill; listener removed on close |
| 3 | Loop abort + `jobStatus` + header status | Complete | |
| 4 | Pool `cancel(jobId)`; client signal aborts running jobs | Complete | `AbortSignal.any` |
| 5 | `AGENT_JOB_TIMEOUT_SECONDS` | Complete | CONF-10 |
| 6 | Prompt builders | Complete | Pure module, 6 tests |
| 7 | `runJob` + four tools | Complete | `index.ts` rewritten around one runner |
| 8 | E2E: tools, cancel, timeout | Complete | 13 e2e tests, 5× green |
| 9 | Docs | Complete | README "Tools" + cancellation; CLAUDE.md rewritten around the semantic tools |
| 10 | Validation + live | Complete | Below |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | |
| Unit Tests | Pass | 250 (225 baseline + 25 new) |
| Build | Pass | |
| Integration | Pass | e2e: six tools listed; `local_analyze` prompt reaches the model; `local_implement` returns a worktree diff; `local_review` refuses empty input and forwards the diff; cancel mid-job → `status cancelled` within a second; `timeout_seconds: 1` → `status timed_out` |
| Edge Cases | Pass | pre-aborted signal (no spawn / no model call), TimeoutError vs cancel reason, unknown job id, review with diff only / paths only, empty `test_commands` |

## Live Validation (2026-09-21, `qwen3.8:27b`, scratch clone)

| Check | Result |
|---|---|
| `local_analyze` (allow-list enforcement question, 2 paths) | `status completed`, 12 iterations, 218 s. First four `grep "a\|b"` calls were rejected — see finding 1 |
| `local_implement` (byte-total line in `list_dir`, criteria + `npx vitest` command) | `status completed`, 6 iterations, 36 s. Two `replace_text` edits, test added, vitest run inside the worktree (25/25), worktree removed. (My harness clipped the returned diff; the diff path itself is covered by e2e.) |
| `local_review` (`replaceText`, focus correctness/edge cases) | `status completed`, 6 iterations, 144 s. Output followed the requested structure exactly: 6 issues with severity + file:line + fix, 9 test gaps, confidence medium. One finding (misleading "required" error for a non-string `new_text`) is a fair catch worth a follow-up |
| `local_cancel` on a running `local_analyze` after 15 s | `[pool] job … cancelled` logged; the job's call returned in the same second with `status cancelled`, 8 steps intact, `[cancelled after 5 iterations; work so far is above]`; worker idle afterwards |

### Found during implementation and live runs
1. **Escaped operators split as separators.** `grep -n "a\|b"` — the most common grep idiom — was rejected by the Phase 3 segment splitter, costing the model four iterations live. A backslash-escaped `|`, `;`, `&` is never a shell separator; the regex now excludes them. Two tests added.
2. **E2E harness pipe deadlock (root cause of the Phase 3 "unexplained flake").** The e2e spawned the server with piped stderr and never read it. After ~64 KB of `[agent]`/`[pool]` logs the pipe fills and `console.error` blocks the server; the looping cancel/timeout tests made this reproducible. Fixed with `child.stderr.resume()`. A worktree orphaned by one such hang (server killed mid-job) was found under `/tmp/local-agent-mcp` and removed by hand — crash cleanup remains a known gap.
3. **Mock Ollama counted aborted requests as in flight.** Fixed by settling on response close; the concurrency test also resets its counters.

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/prompts.ts` | CREATED | +56 |
| `src/__tests__/prompts.test.ts` | CREATED | +67 |
| `src/index.ts` | UPDATED | +209 / -67 (rewritten around `runJob`) |
| `src/__tests__/server.e2e.test.ts` | UPDATED | +115 / -12 |
| `src/__tests__/loop.test.ts` | UPDATED | +59 / -3 |
| `src/loop.ts` | UPDATED | +52 / -12 |
| `src/__tests__/pool.test.ts` | UPDATED | +41 |
| `src/tools.ts` | UPDATED | +34 / -4 |
| `src/__tests__/tools.test.ts` | UPDATED | +33 |
| `src/pool.ts` | UPDATED | +28 / -8 |
| `src/__tests__/config.test.ts` | UPDATED | +16 |
| `src/__tests__/ollama.test.ts` | UPDATED | +11 / -1 |
| `src/__tests__/security.test.ts` | UPDATED | +10 / -6 |
| `src/config.ts` | UPDATED | +6 / -1 |
| `src/ollama.ts` | UPDATED | +4 |
| `src/security.ts` | UPDATED | +4 / -2 |
| `README.md` | UPDATED | +30 / -1 |
| `CLAUDE.md` | UPDATED | +55 / -48 |

## Deviations from Plan
1. Escaped-operator fix in `security.ts` (above) — not in the plan; found live.
2. `local_analyze` description mentions failure diagnosis explicitly, since `local_test_failure` was not built.
3. `formatAgentResult`'s abort line reads `[cancelled after N iterations; work so far is above]` — slightly longer than planned, to make the partial nature unmistakable.

## Issues Encountered
- Two `index.ts` writes were refused because prettier had touched the file between my read and write; re-read and rewrote.
- The git-safety hook blocks any shell heredoc containing the text `git commit`, even as test data; patches were applied via scratchpad scripts. No hooks bypassed.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `prompts.test.ts` | 6 | every input present; optional sections omitted; diff fence |
| `loop.test.ts` | +5 | cancelled mid-run, pre-aborted, timed_out reason, `jobStatus`, header/log line |
| `server.e2e.test.ts` | +5 | six tools, analyze prompt, implement diff, review guard + diff, cancel, timeout |
| `pool.test.ts` | +2 | cancel by id; client signal aborts running job |
| `tools.test.ts` | +2 | bash killed on abort; no spawn when pre-aborted |
| `config.test.ts` | +2 | job timeout |
| `security.test.ts` | +2 | escaped `\|` and `\;` |
| `ollama.test.ts` | +1 | abort reason passes through |

## Code Review Follow-up (2026-09-21, `/code-review` medium, 3 findings, all addressed)

| # | Finding | Fix |
|---|---|---|
| 1 | High — my escaped-operator fix let `echo x \\\\| id` through: `\\\\` is an escaped backslash, so the pipe is live | Lookbehind now requires an *odd* run of backslashes before the operator; 3 tests added |
| 2 | Medium — cancel during the tier-3 correction retries was reported as `parse_failed` (the parser swallows the aborted `chatFn`) | `if (signal?.aborted) break;` after `parseToolCall`; test added |
| 3 | Low — after an abort, the remaining tool calls in the same batch still ran (a `write_file` behind a killed `bash`) | Abort check inside the batch loop; test added |


### Found while verifying the review fixes
4. **Server crash on git stdin EPIPE (Phase 3 bug, High).** `runGit` in `src/worktree.ts` ended git's stdin without an `error` handler on that stream. Commands that never read stdin (`rev-parse`, `worktree add`) can exit first, so the write raises `EPIPE` and the unhandled `'error'` event **crashed the whole MCP server** — seen as the e2e failing 1 run in 6 from `local_implement` onward, with `Error: write EPIPE … worktree.ts:44` in the captured stderr. This is also how worktrees got orphaned earlier. Fixed by ignoring stdin errors (harmless when the command does not read stdin). 8 consecutive e2e runs clean afterwards.
5. My new batch-abort loop test was racy (abort on a 0 ms timer against an async tool); it now aborts a sleeping `bash` deterministically.

The e2e harness now writes the server's stderr to `$E2E_STDERR` when that variable is set, which is how finding 4 was caught.

255 tests total; three consecutive full-suite runs green.

## Not Verified
- Whether Ollama stops generating server-side when the aborted connection closes (`/api/ps` still showed the model loaded after the cancel, which says nothing either way). Worst case: one generation's worth of GPU time.
- Whether Claude Code / Codex surface their own cancel to the server as a request abort.
- Crash cleanup of worktrees (`git worktree prune` on startup would close it).

## Next Steps
- [ ] `/code-review`, then `/prp-commit`
- [ ] Small follow-ups from the live review: split the non-string `new_text` error; consider `test`/`[` on the read-only list
- [ ] Phase 5 (provider abstraction, OpenAI-compatible endpoint, streaming) or Phase 6 (job records, metrics)
