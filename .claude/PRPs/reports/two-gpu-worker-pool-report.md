# Implementation Report: Two-GPU Worker Pool (Goal Doc Phase 2)

## Summary
The server now drives N Ollama endpoints through a `WorkerPool`: one job per worker at a time, FIFO queue for the overflow, a health probe before every dispatch with failover to the next worker, an optional `worker` argument on `run_local_agent`, a `[worker … | job … | …s | … iterations]` header on every report, and a `local_worker_status` tool. `AGENT_WORKERS=id=url,id=url` configures the pool; `OLLAMA_HOST` alone still means one worker named `default`. The agent loop itself did not change.

**Scope change during implementation:** the user decided not to set up a second Ollama instance for now. The pool was built in full and proven with mock servers plus one live endpoint (and a deliberately dead one). The second-instance systemd recipe stayed in the archived plan and was left out of the README.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Single pass; one live finding fixed (`probing` state) |
| Files Changed | 10 (4 new) | 12 (4 new) — plus the loop test and this report |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 0 | Branch + baseline | Complete | 114 tests |
| 1-2 | `AGENT_WORKERS` config + tests | Complete | `URL.canParse` + scheme regex instead of try/catch around `new URL` |
| 3-4 | `checkHealth` + tests | Complete | Real `node:http` servers, no mocks |
| 5-6 | `WorkerPool` + tests | Complete | 15 tests incl. same-tick double-claim race and queue drain when the last worker dies |
| 7 | Report header | Complete | |
| 8 | Wire server, `worker` arg, `local_worker_status` | Complete | Uses the SDK's `extra.signal` to drop cancelled queued calls |
| 9 | End-to-end test | Complete | Real server over stdio vs two mock Ollamas; 3× green in a row |
| 10 | Docs | Complete | README "Multiple workers" + troubleshooting; CLAUDE.md rules 7-9 |
| 11 | Validation + live | Complete | See below |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc --noEmit`, `eslint src/` clean |
| Unit Tests | Pass | 148 (114 baseline + 34 new) |
| Build | Pass | |
| Integration | Pass | `server.e2e.test.ts`: 3 concurrent calls → `maxInFlight === 1` on each mock, both workers used, elapsed within 2-3 chat rounds; unknown worker → `isError`; explicit worker honoured; dead worker → `unhealthy` and jobs continue on the live one |
| Edge Cases | Pass | empty/invalid `AGENT_WORKERS` ×7, refused/500/hanging health, all-unhealthy, recovery, job throws, abort while queued, already-aborted signal |

## Live Validation (2026-09-21, one Ollama 0.34.2 endpoint, `qwen3.8:27b`, scratch copy of the repo)

| Check | Result |
|---|---|
| `OLLAMA_HOST` only (old config) | Job ran on `worker default`, header present, same behaviour as Phase 1 |
| `AGENT_WORKERS=dead=<host>:11435,live=<host>:11434`, two parallel jobs | `[pool] worker dead unhealthy` logged; both jobs ran on `live` one after the other (5.6 s then 10.1 s, second header shows the queue wait); `local_worker_status` at +3 s showed `live` busy with `job_id` and `busy_seconds: 3` |

### Found during live runs
`local_worker_status` showed the dead worker as `busy` with no job — it had been claimed by the second job and its 3 s health probe had not answered yet. Not wrong (the claim is what prevents a double dispatch) but misleading. Fixed: a claimed worker with no `job_id` is reported as `probing`. One test added.

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/pool.ts` | CREATED | +192 |
| `src/__tests__/pool.test.ts` | CREATED | +256 |
| `src/__tests__/server.e2e.test.ts` | CREATED | +188 |
| `src/__tests__/ollama.test.ts` | CREATED | +53 |
| `src/index.ts` | UPDATED | +46 / -16 |
| `src/config.ts` | UPDATED | +40 / -6 |
| `src/__tests__/config.test.ts` | UPDATED | +37 / -3 |
| `src/loop.ts` | UPDATED | +16 / -2 |
| `src/ollama.ts` | UPDATED | +12 |
| `src/__tests__/loop.test.ts` | UPDATED | +8 |
| `README.md` | UPDATED | +42 / -1 |
| `CLAUDE.md` | UPDATED | +4 |

## Deviations from Plan
1. **No second Ollama instance** — user decision mid-implementation. Dual-GPU live check and the README setup section dropped; the code is unchanged by this.
2. **`probing` snapshot state** added after the live run (above). `WorkerSnapshot.status` is `WorkerStatus | "probing"`; the internal state machine still has three states.
3. **URL validation** uses `URL.canParse` (Node 19.9+; this project runs Node 22) rather than try/catch — shorter, same result.
4. **Health test for a closed port** reuses the `listen` helper then closes the server, so the port is known-free; the plan described the same idea.

## Issues Encountered
None beyond the `probing` finding.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `src/__tests__/pool.test.ts` | 15 | parallel dispatch, FIFO, explicit worker, unknown id, double-claim race, job error, failover, all-down, recovery, queue drain on death, abort queued, pre-aborted, status incl. probing |
| `src/__tests__/server.e2e.test.ts` | 5 | tools/list, 3 concurrent calls, unknown worker, explicit worker, dead worker + status |
| `src/__tests__/ollama.test.ts` | 4 | health 200 / 500 / refused / hang |
| `src/__tests__/config.test.ts` | +9 | defaults, `OLLAMA_HOST`, `AGENT_WORKERS` parse, precedence, 7 invalid forms |
| `src/__tests__/loop.test.ts` | +1 | report header |

## Not Verified
- Two real GPUs working at once — no second instance exists yet. Concurrency is proven against mock servers only.
- Whether Claude Code or Codex actually issue two `tools/call` requests to one MCP server concurrently. If they serialise, the pool still provides health checks, failover, and status; parallelism would need a `local_parallel` tool (goal doc §17).
- Client-side timeout behaviour for a call that waits in the queue behind a long job.

## Next Steps
- [ ] `/code-review`, then `/prp-commit`
- [ ] When GPU 2 is ready: follow the recipe in the archived plan, set `AGENT_WORKERS`, run two parallel jobs and watch `nvidia-smi`
- [ ] Phase 3 (worktree isolation) — the "do not run two write jobs in parallel" rule is documentation only until then
