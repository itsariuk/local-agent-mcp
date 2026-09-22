# Implementation Report: Job Records and Metrics (Goal Doc Phase 6)

## Summary
Every job now leaves a record under `AGENT_JOB_LOG_DIR` (default `~/.local/state/local-agent-mcp/jobs/<id>/`): `request.json`, `result.json` (status, iterations, elapsed, tokens, tool calls, files read/changed, commands with pass/fail, chars consumed/returned), `transcript.jsonl` (the full history with unclipped tool output), and `patch.diff` for implement jobs. Token usage from both providers is summed per job and shown in the header (`2.5k→577 tok`). `local_worker_status` gains per-worker totals (`jobs`, `busy_seconds_total`, `tokens`) and a server-lifetime `metrics` block including `supervisor_context_saved_chars`. `local_job_log(job_id, tail?)` reads a record back, and every non-`completed` result ends with a hint to call it.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Single pass; one design correction from the live run |
| Files Changed | 10 (2 new) | 11 (2 new) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 0 | Branch + baseline | Complete | 273 tests |
| 1 | `AgentResult.usage` + `messages`; header tokens; log hint | Complete | Correction-turn usage counted too |
| 2 | Pool per-worker totals + `recordUsage` | Complete | |
| 3 | `AGENT_JOB_LOG_DIR` (CONF-12, XDG default) | Complete | |
| 4 | `jobs.ts`: records, `summarizeResult`, `Metrics` | Complete | Job id validated by regex before any path is built |
| 5 | Wire into `runJob`; `local_job_log`; `metrics` in status | Complete | Deviated — see below |
| 6 | E2E: record on disk, `local_job_log`, metrics | Complete | Asserts the record exists the moment the call returns |
| 7 | Docs | Complete | README "Job records and metrics", tools table, config row, benchmarking note |
| 8 | Validation + live | Complete | Below |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | |
| Unit Tests | Pass | 289 (273 baseline + 16 new) |
| Build | Pass | |
| Integration | Pass | e2e 15 tests, 3× green: seven tools listed; implement job leaves all four files; `result.json` has `files_changed: ["worker.txt"]`, `usage {2,2}`; `local_job_log` returns request + tail; unknown id → `isError`; metrics counters advance |
| Edge Cases | Pass | malformed job id never touches the filesystem; unwritable dir resolves and logs; empty patch not written; negative "savings" clamped to 0; usage absent → no `tok` in header |

## Live Validation (2026-09-21, `qwen3.8:27b`, records pointed at a scratch dir)

| Check | Result |
|---|---|
| `local_analyze` (native worker) | Header `2.5k→526 tok`; `result.json`: `status completed`, `usage {2471, 577}`, `tool_calls 1`, `files_read ["src/security.ts"]`, `chars_consumed 5457`, `chars_returned 1510`; transcript 5 entries (system, user, assistant, tool, assistant) |
| `local_job_log` from a **fresh** server process | Returned the stored request, result and the last 3 transcript entries |

### Found during the live run
**Records lost when the client exits immediately.** The first live run produced an empty `result.json` and no transcript: the writes were fire-and-forget (as planned) and my harness killed the server right after the response. Any one-shot client would hit the same. Changed so that writes start inside the job but are awaited **after** `pool.run` returns — the worker is already released (the disk never holds a GPU), yet the client cannot receive a response before its record is on disk. The e2e now reads `result.json` with no polling to lock that guarantee. Second live run: all files complete.

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/jobs.ts` | CREATED | +227 |
| `src/__tests__/jobs.test.ts` | CREATED | +169 |
| `src/index.ts` | UPDATED | +171 / -50 |
| `src/__tests__/server.e2e.test.ts` | UPDATED | +75 / -15 |
| `src/loop.ts` | UPDATED | +45 / -3 |
| `src/__tests__/loop.test.ts` | UPDATED | +39 / -2 |
| `README.md` | UPDATED | +33 |
| `src/pool.ts` | UPDATED | +26 / -1 |
| `src/__tests__/pool.test.ts` | UPDATED | +25 / -1 |
| `src/__tests__/config.test.ts` | UPDATED | +17 |
| `src/config.ts` | UPDATED | +14 / -1 |

## Deviations from Plan
1. Record writes are awaited after worker release instead of pure fire-and-forget (above). Same GPU-freeing property, no lost records.
2. The dead-worker e2e assertion switched from exact `toEqual` on the whole status payload to `toMatchObject` on the fields it tests; the payload now carries totals and `metrics`.

## Issues Encountered
- Two patch scripts aborted on prettier-rewrapped anchors and were re-applied against the actual text; no partial writes reached disk.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `jobs.test.ts` | 8 | round-trip, empty patch, tail, missing/malformed id, unwritable dir, `summarizeResult`, `toUsageRecord`, `Metrics` sums + clamp |
| `loop.test.ts` | +3 | usage summed / absent, transcript, header tokens, log hint |
| `pool.test.ts` | +1 | per-worker jobs / busy time / tokens |
| `config.test.ts` | +1 | default, `XDG_STATE_HOME`, `AGENT_JOB_LOG_DIR` |
| `server.e2e.test.ts` | +1 | record on disk, `local_job_log`, metrics |

## Code Review Follow-up (2026-09-21, `/code-review` medium, 2 findings, both addressed)

| # | Finding | Fix |
|---|---|---|
| 1 | Low — `??` treated an empty `XDG_STATE_HOME` / `AGENT_JOB_LOG_DIR` as set, so `AGENT_JOB_LOG_DIR=""` would have written records into the working repo | `\|\|` (empty means unset, as elsewhere in `loadConfig`); test added |
| 2 | Low in label, real in effect — a backend failure mid-job (5xx, bad JSON) threw out of the loop with the partial transcript and usage lost, so `local_job_log` returned nothing for the jobs that most need it | The loop throws a `LoopError` carrying the partial `AgentResult`; `runJob` records it. Loop test + e2e (a mock 500 on the second turn leaves a `failed` record with `iterations: 2`, `tool_calls: 1` and a 4-entry transcript) |

289 tests total; two consecutive full-suite runs green, e2e 3×.

## Not Verified
- Behaviour with very large transcripts (multi-MB tool output) — written in one `writeFile`; fine for local disk, untested at scale.
- Any aggregation of the on-disk records across restarts (out of scope; the files are plain JSON/JSONL).

---

## Goal Doc §27 Acceptance Criteria — Final Status

| Criterion | Status |
|---|---|
| Claude Code can connect through MCP | Done (Phase 1) |
| Codex can connect through the same MCP server | Server is client-agnostic; **not tested with a Codex client** |
| Two Qwen instances can be configured | Done (Phase 2, `AGENT_WORKERS`) |
| Each worker pinned to a separate endpoint/GPU | Done in code; **second GPU instance not set up** (user deferred) |
| Two independent jobs execute concurrently | Done, proven with mock servers (Phase 2) |
| A third job queues | Done (Phase 2) |
| Analysis jobs enforced read-only | Done (Phase 3) |
| Implementation jobs run in isolated worktrees | Done (Phase 3) |
| Two write jobs cannot corrupt each other | Done (Phase 3) |
| Main working tree never silently modified by implement | Done (Phase 3; `direct` mode is the explicit opt-in) |
| Worker can search/read/edit/patch/run tests | Done (Phases 1, 3) |
| Worker iterates after test failures | Done, live (Phase 1) |
| Result: summary + changed files + tests + diff | Done (Phases 3, 4) |
| Full transcript not dumped by default | Done; retrievable via `local_job_log` (Phase 6) |
| Jobs have IDs and persisted logs | Done (Phases 2, 6) |
| Jobs time out safely | Done (Phase 4) |
| Jobs can be cancelled | Done (Phase 4) |
| Backend health visible | Done (Phase 2) |
| Worker status queryable | Done (Phase 2) |
| Failed jobs do not pretend to succeed | Done (`status` in every header, Phase 4) |
| Supervisor instructions encourage delegation, keep verification | Done (`CLAUDE.md`, Phase 4) |
| Provider not tied to Ollama | Done (Phase 5); **vLLM/llama.cpp not run**, only Ollama `/v1` |
| Existing `run_local_agent` remains compatible | Done throughout |

Deferred by decision or environment: Codex client test, second GPU instance, non-Ollama OpenAI-compatible servers, `local_test_failure` (covered by `local_analyze`), streaming (no trigger yet), transcript redaction, worktree crash-prune.

## Next Steps
- [ ] `/code-review`, then `/prp-commit`; merge and push
- [ ] When GPU 2 comes online: follow the recipe in `plans/completed/two-gpu-worker-pool.plan.md`
- [ ] Run `claude-memory-init` if work continues past the goal doc — six phases of decisions currently live only in `.claude/PRPs/`
