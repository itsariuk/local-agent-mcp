# Plan: Job Records and Metrics (Goal Doc Phase 6)

## Summary
Persist one record per job (request, result, full transcript, patch) under a state directory, count tokens and time per job and per worker, and expose the totals — including "supervisor context saved" — through `local_worker_status`. Add `local_job_log(job_id)` so the supervisor can pull a failed job's transcript on demand instead of getting it in every result. This is the last phase of the goal doc; it answers §14's question: *how much paid work are local workers replacing?*

## User Story
As the operator,
I want every delegated job to leave a record with tokens, timing, tool calls and outcome, and a running total per worker,
So that I can see what the GPUs are actually saving and dig into any job that went wrong.

## Problem → Solution
A job's only trace is the text returned to the supervisor (clipped) and stderr lines. Token counts are captured by the providers (Phase 5) and dropped. There is no per-worker utilisation, no way to see a failed job's full transcript.
→ `~/.local/state/local-agent-mcp/jobs/<job-id>/{request.json,result.json,transcript.jsonl,patch.diff}`; `AgentResult.usage`; tokens in the header; counters and busy time in `local_worker_status`; `local_job_log`.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `local-agent-mcp-dual-3090-orchestration-goal.md`
- **PRD Phase**: §28 "Phase 6 — Observability and optimization" (§12, §14, §15). Phases 1-5 complete.
- **Estimated Files**: 10 (2 created, 8 updated)

---

## UX Design

### Before
```
[worker gpu0 | qwen3.8:27b | job 3f2a1c9e | 41.2s | 7 iterations | mode implement | status completed]
(nothing on disk; local_worker_status shows live state only)
```

### After
```
[worker gpu0 | qwen3.8:27b | job 3f2a1c9e | 41.2s | 7 iterations | 18.4k→1.2k tok | mode implement | status completed]

~/.local/state/local-agent-mcp/jobs/3f2a1c9e/
  request.json     {job_id, tool, mode, prompt, worker, model, max_iterations, timeout_seconds, started_at}
  result.json      {status, iterations, elapsed_ms, usage, tool_calls, files_read, files_changed,
                    commands_run, chars_consumed, chars_returned, finished_at, worktree?}
  transcript.jsonl one line per chat message (system, user, assistant, tool) — unclipped tool output
  patch.diff       implement mode only

local_worker_status → {
  workers: [{ id, status, provider, model, jobs: 12, busy_seconds_total: 812, tokens: {prompt, completion} }],
  queued: 0,
  metrics: { jobs: {started, completed, stopped_at_limit, parse_failed, cancelled, timed_out, failed, blocked},
             tokens: {prompt, completion}, tool_calls, chars_consumed, chars_returned,
             supervisor_context_saved_chars, since }
}

local_job_log(job_id, tail?) → result.json + the last N transcript entries
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Result header | no tokens | `| 18.4k→1.2k tok |` when the backend reports usage | omitted when unknown |
| Disk | nothing | one directory per job under `AGENT_JOB_LOG_DIR` (default `$XDG_STATE_HOME/local-agent-mcp/jobs`, i.e. `~/.local/state/…`) | never inside the repo: would pollute checkouts and get copied into worktree snapshots |
| `local_worker_status` | live state | + per-worker totals + `metrics` block | same tool, more fields |
| New tool | — | `local_job_log(job_id, tail?)` | reads the record; no live state |
| Failure | 500-char excerpt | same, plus "full log: local_job_log(<id>)" hint on non-`completed` statuses | one line |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/index.ts` | 46-100 | `runJob` — where the record is assembled and written |
| P0 | `src/loop.ts` | 21-28, 120-130, 199-248 | `AgentResult`, `messages` (the transcript), the two return sites |
| P0 | `src/pool.ts` | 19-27, 113-140, 150-175 | snapshot; `execute`/`release` where per-worker totals accumulate |
| P1 | `src/provider.ts` | 25-28 | `ChatResponse.usage` already delivered by both providers |
| P1 | `src/config.ts` | 43-53, 100-120 | `parsePositiveInt`, CONF-nn numbering (next is CONF-12) |
| P2 | `src/worktree.ts` | 1-30 | style for a small fs-facing module |
| P2 | `src/__tests__/worktree.test.ts` | 1-40 | temp-dir test style for fs modules |

## External Documentation
No external research needed — feature uses established internal patterns. (`XDG_STATE_HOME` default `~/.local/state` is the freedesktop convention; `~/.local/state` already exists on this machine.)

---

## Patterns to Mirror

### FS_MODULE_PATTERN
// SOURCE: src/worktree.ts:1-3, 128-135
Header comment; best-effort cleanup that logs instead of throwing:
```ts
/** Best effort: a leftover worktree is reported, never fatal. */
export async function removeWorktree(root: string, wtPath: string): Promise<void> {
  try {
    await runGit(root, ["worktree", "remove", "--force", wtPath]);
  } catch (err) {
    console.error(`[worktree] failed to remove ${wtPath}: ${err instanceof Error ? err.message : err}`);
  }
}
```
Job-record writes follow this: a failed write is logged as `[jobs] …` and never fails the job.

### SNAPSHOT_PATTERN
// SOURCE: src/pool.ts:126-136
snake_case keys, optional fields spread in only when present.

### HEADER_PATTERN
// SOURCE: src/loop.ts:265-275
One bracketed line, ` | `-separated, built from `RunInfo` + result.

### CONFIG_PATTERN
// SOURCE: src/config.ts:112-117
```ts
  // CONF-11: bearer token for OpenAI-compatible servers that want one
  const apiKey = process.env.AGENT_API_KEY || undefined;
```

### TEST_STRUCTURE
// SOURCE: src/__tests__/worktree.test.ts:14-30
`fs.mkdtemp` per test, `afterEach` `fs.rm(..., {recursive: true, force: true})`.

---

## Files to Change

| File | Action | Responsibility |
|---|---|---|
| `src/jobs.ts` | CREATE | `JobRecord` types, `writeJobRecord`, `readJobRecord`, `Metrics` (in-memory counters) |
| `src/__tests__/jobs.test.ts` | CREATE | write/read round-trip, missing job, metrics accumulation |
| `src/loop.ts` | UPDATE | `AgentResult.usage` + `messages`; tokens in header; log hint |
| `src/pool.ts` | UPDATE | per-worker `jobs`, `busy_seconds_total`, `tokens`; `recordUsage(workerId, usage)` |
| `src/config.ts` | UPDATE | `AGENT_JOB_LOG_DIR` |
| `src/index.ts` | UPDATE | assemble + write records; feed metrics; `local_job_log`; `metrics` in status |
| `src/__tests__/{loop,pool,config,server.e2e}.test.ts` | UPDATE | usage, totals, config, e2e record on disk |
| `README.md` | UPDATE | Job records, metrics, `local_job_log`, `AGENT_JOB_LOG_DIR` |

## NOT Building

- A benchmark harness for Claude-vs-Codex supervision (§30). That is a human procedure; the records this phase writes are its raw data. A short "How to benchmark" note goes in the README instead.
- Retention / rotation of job directories. Records are small (tens of KB); add a `local_job_prune` if the directory ever matters.
- GPU utilisation, VRAM, tokens/sec (§15 optional). Needs host-side access; out of scope for an MCP server.
- Persisting metrics across restarts. Counters are per server process (`since` is reported); the on-disk records are the durable source and can be aggregated offline.
- Redaction of secrets in transcripts (§22). Transcripts stay local under the user's state dir; flag in README.
- A Prometheus endpoint or any UI (§31).
- `test_pass_rate` (§15). Requires parsing arbitrary test runner output; `commands_run` with exit status is recorded instead.

---

## Step-by-Step Tasks

### Task 0: Branch and baseline
- **ACTION**: `git checkout -b feat/job-records-and-metrics` from `main`; `npm test`.
- **VALIDATE**: 273 pass.

### Task 1: Loop reports usage and transcript (test first)
- **ACTION**: `src/__tests__/loop.test.ts`, then `src/loop.ts`.
- **IMPLEMENT**:
  - `AgentResult` gains `usage?: { promptTokens: number; completionTokens: number }` and `messages: OllamaMessage[]`.
  - In the loop, after each successful `provider.chat` (main and correction `chatFn`): if `response.usage`, add into a running `usage` accumulator (created on first sight). Both return sites include `messages` and `usage` (only when defined).
  - `RunInfo` unchanged; header inserts `${fmtTokens(usage)}` between iterations and mode when `result.usage` is set: `18.4k→1.2k tok` (`fmtTokens`: `< 1000` → `n`, else `(n/1000).toFixed(1) + "k"`).
  - When `jobStatus(result) !== "completed"`, append a final log line `[full log: local_job_log("<jobId>")]` — the id comes from `run.jobId`, so only when `run` is given.
  - Tests: two `reply()`s carrying `usage: {promptTokens: 10, completionTokens: 5}` and `{20, 7}` → `result.usage` equals `{30, 12}`; no usage → `result.usage` undefined; `result.messages` has system+user+assistant+tool+assistant entries for the 1-tool run; header contains `| 30→12 tok |` and, for a cancelled result with `run`, the `local_job_log` hint; header for `promptTokens: 18_400` shows `18.4k`.
- **GOTCHA**: The correction `chatFn`'s usage counts too — it is real GPU work.
- **VALIDATE**: loop tests green; `npm run typecheck` (existing callers unaffected — new fields are additive).

### Task 2: Pool per-worker totals (test first)
- **ACTION**: `src/__tests__/pool.test.ts`, then `src/pool.ts`.
- **IMPLEMENT**:
  - `WorkerState` gains `jobs: number`, `busyMsTotal: number`, `tokens: { prompt: number; completion: number }` (all zero-initialised in the constructor).
  - `execute`: `worker.jobs++`; in `finally`, before `release`, `worker.busyMsTotal += Date.now() - worker.busySince!`.
  - `recordUsage(workerId: string, usage: { promptTokens: number; completionTokens: number }): void` — adds to the worker's tokens; unknown id ignored.
  - `WorkerSnapshot` gains `jobs`, `busy_seconds_total` (rounded), `tokens: { prompt, completion }` — always present.
  - Tests: after two gated jobs on one worker, `jobs === 2` and `busy_seconds_total >= 0`; `recordUsage("gpu0", {10, 5})` twice → `tokens {20, 10}`; existing `toEqual` snapshot assertions gain the three fields (`jobs: 0, busy_seconds_total: 0, tokens: {prompt: 0, completion: 0}`).
- **VALIDATE**: pool tests green.

### Task 3: Config — `AGENT_JOB_LOG_DIR` (test first)
- **ACTION**: `src/__tests__/config.test.ts`, then `src/config.ts`.
- **IMPLEMENT**: CONF-12: `jobLogDir = process.env.AGENT_JOB_LOG_DIR ?? path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "local-agent-mcp", "jobs")`; import `os`/`path`. Tests: default ends with `local-agent-mcp/jobs` and starts with the home dir; `XDG_STATE_HOME=/x` → `/x/local-agent-mcp/jobs`; `AGENT_JOB_LOG_DIR=/y` → `/y`. Add both env names to `ENV_KEYS`.
- **VALIDATE**: config tests green.

### Task 4: `jobs.ts` — records and metrics (test first)
- **ACTION**: Create `src/__tests__/jobs.test.ts`, then `src/jobs.ts`.
- **IMPLEMENT**:
  ```ts
  // Per-job records on disk and in-process metrics. Writes are best effort:
  // a failed write is logged, never surfaced to the job.

  export interface JobRequestRecord {
    job_id: string; tool: string; mode: string; prompt: string; worker: string;
    provider: string; model: string; max_iterations: number; timeout_seconds: number;
    started_at: string;
  }
  export interface JobResultRecord {
    job_id: string; status: string; iterations: number; elapsed_ms: number;
    usage?: { prompt_tokens: number; completion_tokens: number };
    tool_calls: number; files_read: string[]; files_changed: string[];
    commands_run: Array<{ command: string; success: boolean }>;
    chars_consumed: number;   // tool output + assistant text the worker processed
    chars_returned: number;   // what the supervisor received
    finished_at: string; worktree?: string; error?: string;
  }
  export async function writeJobRecord(dir: string, id: string, files: {
    request?: JobRequestRecord; result?: JobResultRecord; transcript?: unknown[]; patch?: string;
  }): Promise<void>;   // mkdir -p dir/id; JSON.stringify(…, null, 2); transcript as JSONL; patch only when non-empty
  export async function readJobRecord(dir: string, id: string, tail = 20): Promise<
    { result?: JobResultRecord; request?: JobRequestRecord; transcript: unknown[] } | undefined
  >;   // undefined when the directory does not exist; transcript = last `tail` lines parsed
  ```
  and
  ```ts
  export class Metrics {
    readonly since = new Date().toISOString();
    private jobs: Record<string, number> = { started: 0 };
    private tokens = { prompt: 0, completion: 0 };
    private toolCalls = 0; private charsConsumed = 0; private charsReturned = 0;
    started(): void;
    finished(result: Pick<JobResultRecord, "status" | "tool_calls" | "chars_consumed" | "chars_returned" | "usage">): void;
    snapshot(): { jobs: Record<string, number>; tokens; tool_calls; chars_consumed; chars_returned; supervisor_context_saved_chars; since };
  }
  ```
  `supervisor_context_saved_chars = max(0, chars_consumed - chars_returned)`.
  Also a pure helper `summarizeResult(result: AgentResult): Pick<JobResultRecord, "tool_calls"|"files_read"|"files_changed"|"commands_run"|"chars_consumed">` — `files_read` from `read_file` step args (deduped), `files_changed` from successful `write_file`/`replace_text` steps (deduped; for implement mode `index.ts` overrides with the diff's file list), `commands_run` from `bash` steps, `chars_consumed` = Σ step output lengths + Σ assistant message content lengths.
  - Tests: write then read round-trip (request, result, 3 transcript lines, patch present only when given); `readJobRecord` of a missing id → `undefined`; `tail` limits transcript lines from the end; a write into an unwritable dir (chmod 000 on a parent, skip if root) rejects **nothing** — resolves and logs; `Metrics`: two `finished` calls with different statuses → counts, tokens summed, `supervisor_context_saved_chars` computed, `started` counted separately; `summarizeResult` over a synthetic `AgentResult` with read/replace/bash steps.
- **MIRROR**: FS_MODULE_PATTERN, SNAPSHOT_PATTERN.
- **GOTCHA**: Job ids are 8 hex chars from `randomUUID()`; validate `id` against `/^[0-9a-f]{8}$/` in `readJobRecord` so `local_job_log` cannot be pointed at `../…`. Use `fs.writeFile` per file; no atomic rename needed (records are write-once).
- **VALIDATE**: `npx vitest run src/__tests__/jobs.test.ts` green.

### Task 5: Wire records and metrics into `runJob`
- **ACTION**: Update `src/index.ts`.
- **IMPLEMENT**:
  - `const metrics = new Metrics();`
  - `JobArgs` gains `tool: string` (each tool passes its name; `run_local_agent` passes `"run_local_agent"`).
  - Inside `pool.run` job, at the top: `metrics.started()`; build `request: JobRequestRecord` and `void writeJobRecord(config.jobLogDir, jobId, { request })` (fire-and-forget, before the loop so a crash still leaves the request).
  - Wrap the existing body so that **both** the success path and the catch path produce a `result` record:
    - success: `status = jobStatus(result)`, `summarizeResult(result)`, `files_changed` = diff file paths when `diff` (strip the `M\t` prefix), `usage` mapped to snake_case, `chars_returned = text.length`, `worktree` only when kept.
    - thrown error: `status = message.startsWith("blocked:") ? "blocked" : "failed"`, `error: message`, zero counts, `elapsed_ms`.
    Then `metrics.finished(record)`, `pool.recordUsage(w.id, usage)` when present, `void writeJobRecord(dir, jobId, { result: record, transcript: result?.messages, patch: diff?.patch })`.
  - `local_worker_status` response: `{ ...(await pool.status()), metrics: metrics.snapshot() }`.
  - New tool `local_job_log`: `{ job_id: z.string().regex(/^[0-9a-f]{8}$/), tail: z.number().int().positive().max(200).optional() }` → `readJobRecord(config.jobLogDir, job_id, tail ?? 20)`; `undefined` → `toolError(new Error(\`no record for job ${job_id} under ${config.jobLogDir}\`))`; else `toolResult(JSON.stringify({ request, result, transcript }, null, 2))`. Description: "Read a finished job's stored record: request, result summary (status, tokens, files, commands) and the last N transcript entries with unclipped tool output. Use it when a result header shows a status other than completed."
  - Startup line: append `| jobs: ${config.jobLogDir}`.
- **GOTCHA**: `writeJobRecord` calls are `void`-ed and never awaited on the hot path; they resolve on their own and log on failure. Do not await them inside the pool job — a slow disk must not hold a GPU. Transcript content can include the full 1 MB tool outputs; that is the point (`transcript.jsonl` is the only place the unclipped output lives).
- **VALIDATE**: `npm run typecheck && npm run lint && npm run build`.

### Task 6: E2E — record on disk, metrics, job log
- **ACTION**: Extend `src/__tests__/server.e2e.test.ts`.
- **IMPLEMENT**: spawn with `AGENT_JOB_LOG_DIR: path.join(tempDir, "..", "jobs-<random>")` (outside the git repo). Tests: after the `local_implement` test, the header's job id has a directory with all four files; `result.json` has `status: "completed"`, `files_changed: ["worker.txt"]`, `tool_calls: 1`, `usage` present (the OpenAI-shaped mock reports 1/1; the Ollama-shaped mock should now also return `prompt_eval_count: 1, eval_count: 1`); `transcript.jsonl` last line is the assistant "done"; `local_job_log({job_id})` returns JSON containing `"status": "completed"` and a transcript array; `local_job_log({job_id: "00000000"})` → `isError`; `local_worker_status.metrics.jobs.started >= 1` and `supervisor_context_saved_chars >= 0`; per-worker `jobs >= 1`. Clean the jobs dir in `afterAll`.
- **GOTCHA**: the record write is async and fire-and-forget: poll for `result.json` up to ~2 s before asserting.
- **VALIDATE**: e2e green 3×.

### Task 7: Docs
- **ACTION**: `README.md`.
- **IMPLEMENT**: "Job records and metrics" section: directory layout, what each file holds, `AGENT_JOB_LOG_DIR` row (+ `XDG_STATE_HOME`), the `metrics` block fields with one-line meanings (esp. `supervisor_context_saved_chars` = characters the worker read/produced minus characters returned to the supervisor — a lower bound on frontier-model context avoided), `local_job_log` in the tools table, header token format. A note that transcripts are unredacted and local. A short "Benchmarking supervisors" paragraph pointing at the records as the data source for §30's A/B (same task, Claude Code vs Codex, compare paid tokens vs `metrics.tokens`).
- **VALIDATE**: `grep -rn "192\.168" README.md CLAUDE.md src .claude/PRPs` empty.

### Task 8: Full validation + live check
- **ACTION**: Validation Commands, then Manual Validation.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| usage accumulates | two replies with usage | summed | core |
| usage absent | replies without usage | undefined, header has no tok | yes |
| transcript in result | 1-tool run | 5 messages | |
| header tokens | 18 400 / 1 200 | `18.4k→1.2k tok` | |
| log hint | cancelled + run | `local_job_log("…")` line | |
| per-worker totals | 2 jobs | `jobs: 2`, busy time ≥ 0 | |
| recordUsage | ×2 | summed; unknown id ignored | yes |
| config dir | default / XDG / explicit | expected paths | |
| record round-trip | all four files | equal; patch only when given | core |
| missing record | unknown id | undefined | yes |
| bad id | `../x` | undefined, no fs access | yes (security) |
| unwritable dir | chmod 000 | resolves, logs | yes |
| metrics | mixed statuses | counts, sums, saved chars | core |
| summarizeResult | read/replace/bash steps | files + commands + chars | |
| e2e record | implement job | four files, correct summary, `local_job_log` works | core |

### Edge Cases Checklist
- [x] Empty input — no usage, no steps, empty patch not written
- [x] Invalid types — job id validated by regex at both layers
- [x] Permission denied — unwritable log dir never fails a job
- [x] Concurrent access — one directory per job id; no shared files
- [ ] Maximum size — transcripts can be large by design; no cap (documented)

---

## Validation Commands

### Static Analysis
```bash
npm run typecheck && npm run lint
```

### Unit Tests
```bash
npx vitest run src/__tests__/jobs.test.ts src/__tests__/loop.test.ts src/__tests__/pool.test.ts src/__tests__/config.test.ts
```

### Full Test Suite
```bash
npm test && npm run build
```
EXPECT: 273 baseline + new pass; e2e 3× green

### Manual Validation
Live endpoint in project memory; scratch clone as `AGENT_WORKING_DIR`; `AGENT_JOB_LOG_DIR` pointed at a scratch dir.
- [ ] `local_analyze` → header shows `N→M tok`; the job directory has `request.json`, `result.json`, `transcript.jsonl`; `result.json` `usage` matches the header; `chars_consumed` > `chars_returned`.
- [ ] `local_implement` → `patch.diff` written and equal to the diff in the result; `files_changed` matches.
- [ ] `local_cancel` a job → `result.json` `status: "cancelled"`, transcript ends at the last completed step; result text ends with the `local_job_log` hint; `local_job_log` returns it.
- [ ] `local_worker_status` after the three jobs → `metrics.jobs` sums to 3 across statuses, `tokens` non-zero, per-worker `jobs: 3`, `busy_seconds_total` plausible.
- [ ] Point `AGENT_JOB_LOG_DIR` at a read-only path → jobs still succeed; `[jobs] failed to write …` on stderr.

---

## Acceptance Criteria
(goal doc §27 items this phase closes)
- [ ] Jobs have IDs and persisted logs
- [ ] Full worker transcript is not dumped into supervisor context by default — but is retrievable
- [ ] Token/timing metrics and worker utilisation are visible
- [ ] typecheck, lint, test, build pass

## Completion Checklist
- [ ] Record writes never block or fail a job
- [ ] Job id validated before any path is built from it
- [ ] Records live outside the repo by default
- [ ] README explains the saved-context metric honestly (a lower bound in characters, not paid tokens)
- [ ] No real hostnames/IPs in committed files

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Transcripts hold secrets read from files | Medium | Medium | Local state dir, documented; redaction is a listed follow-up |
| `chars_consumed − chars_returned` overstates savings (the supervisor might not have read everything) | High | Low | Named a lower-bound-in-chars estimate everywhere; never converted to "tokens saved" or money |
| Disk fills over months of records | Low | Low | ~tens of KB per job; prune tool later |
| Fire-and-forget write still pending when the server exits | Low | Low | Node keeps the process alive for pending fs ops; acceptable |

## Notes
- After this phase every §27 acceptance item is either done or explicitly deferred with a reason: Codex connection (untested client-side, server is client-agnostic), two live GPUs (second instance not set up), vLLM/llama.cpp (not installed). The report should close with that checklist filled in.
- This is a good moment to run `claude-memory-init` if the project continues beyond the goal doc: six phases of decisions now live only in `.claude/PRPs/`.
