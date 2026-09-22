# Plan: Semantic Tools and Cancellation (Goal Doc Phase 4)

## Summary
Add the supervisor-facing tools the goal doc asks for — `local_analyze`, `local_implement`, `local_review`, `local_cancel` — on top of the modes from Phase 3, and make running jobs cancellable: `local_cancel(job_id)`, a per-job wall-clock timeout (`AGENT_JOB_TIMEOUT_SECONDS`, default 900), and client disconnects all abort the in-flight inference request and the shell subprocess, then return the work done so far (steps, partial diff) with an honest status instead of pretending success. `run_local_agent` stays as the free-form escape hatch.

## User Story
As a Claude Code / Codex supervisor,
I want to say `local_implement({objective, paths, acceptance_criteria, test_commands})` and get a tested patch back, or `local_cancel(job)` when a job has clearly gone wrong,
So that delegation is a structured contract rather than prompt-crafting, and a runaway job never holds a GPU.

## Problem → Solution
One free-form tool; the supervisor writes the whole worker prompt itself; `mode` is easy to forget; a job that loops or hangs runs until `maxIterations`; nothing can stop it.
→ Three semantic tools that build tight, mode-correct prompts from structured inputs; a job id in every result; `local_cancel`; job timeout; abort plumbed through inference and shell; partial results on abort with `status` in the header.

## Metadata
- **Complexity**: Medium-Large
- **Source PRD**: `local-agent-mcp-dual-3090-orchestration-goal.md`
- **PRD Phase**: §28 "Phase 4 — Better MCP API" (§7, §16, §25). Phases 1-3 complete.
- **Estimated Files**: 12 (2 created, 10 updated)

---

## UX Design

### Before
```
run_local_agent(prompt="Read src/x.ts. Using replace_text ... Run npx vitest ... Do not read other files.", mode="implement")
   → runs until done or 20 iterations; no way to stop it
```

### After
```
local_analyze({objective, paths, constraints?})                     → read-only findings
local_implement({objective, paths, acceptance_criteria, test_commands, constraints?}) → diff + report
local_review({objective, paths?, diff?, review_focus?})            → issues with severity, file:line, fix, confidence
local_cancel({job_id})                                             → "cancelling job 3f2a1c9e on gpu0"
local_worker_status / run_local_agent                              → unchanged

every result header: [worker gpu0 | qwen3.8:27b | job 3f2a1c9e | 41.2s | 7 iterations | mode implement | status cancelled]
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| New tools | — | `local_analyze`, `local_implement`, `local_review`, `local_cancel` | all MCP-generic, no Claude-specific wording |
| Common optional inputs on the three job tools | — | `worker?`, `model?`, `max_iterations?`, `timeout_seconds?` | per-call overrides of config |
| Header | `… \| mode X]` | `… \| mode X \| status completed]` | statuses: `completed`, `stopped_at_limit`, `parse_failed`, `cancelled`, `timed_out` |
| Cancelled / timed-out job | n/a | not `isError`; returns steps so far, partial diff (implement), `[cancelled after N iterations]` line | §25 "do not fabricate partial success" — the status says what happened |
| Client cancels a running call | job keeps running on the GPU | job aborted, worker freed | was queued-only in Phase 2 |
| Config | — | `AGENT_JOB_TIMEOUT_SECONDS` (default `900`) | §24 `job_timeout_seconds` |
| Worktree on cancel/timeout | n/a | diff captured, worktree removed (same as success) | the partial diff is the useful artefact; the tree is not |
| `run_local_agent` | as is | unchanged inputs; gains the same header/status and abort behaviour | |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/index.ts` | 39-118 | The handler body to extract into `runJob`; registration shape |
| P0 | `src/loop.ts` | 56-80, 118-132, 183-200, 220-262 | options, chat call, tool call, `formatAgentResult` |
| P0 | `src/pool.ts` | 60-100, 141-155 | `run`/`execute` — where the per-job `AbortController` lives |
| P0 | `src/tools.ts` | 205-297 | `bashExec` timer/kill — reuse for abort |
| P1 | `src/ollama.ts` | 44-76 | `chatWithOllama(host, request)` — add `signal` |
| P1 | `src/config.ts` | 43-53, 103-108 | `parsePositiveInt`, CONF-nn |
| P2 | `src/__tests__/server.e2e.test.ts` | 24-75, 100-140 | mock Ollama scripting (`write:` prefix) and stdio client to extend |
| P2 | `src/__tests__/pool.test.ts` | 1-40 | `gatedJob` helper for cancel tests |
| P2 | `src/__tests__/loop.test.ts` | 1-50 | `vi.mock` of `chatWithOllama` |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| `AbortSignal.any` / `AbortSignal.timeout` | verified 2026-09-21: both are functions on Node v22.23.2 | Combine the client's signal, the cancel signal and the job timeout into one without manual listener bookkeeping |
| `fetch` + `signal` | Node built-in | Aborting rejects with `DOMException` name `AbortError`; `AbortSignal.timeout` rejects with name `TimeoutError` |

```
KEY_INSIGHT: `signal.reason` tells cancel apart from timeout — `AbortSignal.timeout` sets a TimeoutError DOMException; our cancel passes `new Error("cancelled by local_cancel")`.
APPLIES_TO: Tasks 3, 5
GOTCHA: `AbortSignal.any` propagates the *first* aborting signal's reason. Check `signal.reason?.name === "TimeoutError"` rather than which input signal fired.

KEY_INSIGHT: A job id exists only once `execute` runs (pool.ts:145). Queued jobs have no id, so `local_cancel` targets running jobs only; a queued call is cancelled by the client abort (Phase 2).
APPLIES_TO: Task 4
GOTCHA: Tell the supervisor that in the tool description.

KEY_INSIGHT: `bashExec` already kills the process group on timeout (tools.ts:284-295). Abort = same kill path with a different reason.
APPLIES_TO: Task 2
GOTCHA: Remove the abort listener on `close` or the listener leaks per command.
```

---

## Patterns to Mirror

### TOOL_REGISTRATION
// SOURCE: src/index.ts:120-130
```ts
server.registerTool(
  "local_worker_status",
  {
    description:
      "Show each local worker's state (idle, busy, probing, unhealthy), ...",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(await pool.status(), null, 2) }],
  }),
);
```

### ERROR_HANDLING
// SOURCE: src/index.ts:106-116
Handler catch → `isError: true`, `Error: <message>`. Aborts are **not** errors (they produce a result with a status).

### RESULT_HEADER
// SOURCE: src/loop.ts:220-227, 268-272
`RunInfo` carries header fields; header is one bracketed line. Extend, do not add a second line.

### DEPENDENCY_INJECTION_PATTERN
// SOURCE: src/pool.ts:52-58, src/__tests__/pool.test.ts:14-27
Inject the network/health function; tests use a `gatedJob` that resolves when the test says so.

### PROMPT_STYLE
// SOURCE: src/loop.ts:33-44 (SYSTEM_PROMPT), 46-54 (ANALYZE_PROMPT)
Short imperative bullets, one rule per line, "When finished, reply with plain text and no tool call: ..." closing sentence.

### TEST_STRUCTURE
// SOURCE: src/__tests__/loop.test.ts:10-11, 40-48
```ts
vi.mock("../ollama.js", () => ({ chatWithOllama: vi.fn() }));
const chat = vi.mocked(chatWithOllama);
```

---

## Files to Change

| File | Action | Responsibility |
|---|---|---|
| `src/prompts.ts` | CREATE | Pure builders: `analyzePrompt`, `implementPrompt`, `reviewPrompt` from structured inputs |
| `src/__tests__/prompts.test.ts` | CREATE | Every input lands in the prompt; empty optionals omitted |
| `src/ollama.ts` | UPDATE | `chatWithOllama(host, request, signal?)`; abort passes through untouched |
| `src/tools.ts` | UPDATE | `bashExec` kills on `signal` abort; `executeTool` takes `signal?` |
| `src/loop.ts` | UPDATE | `signal?` option; abort → `AgentResult.aborted`; `status` in header; `jobStatus()` |
| `src/pool.ts` | UPDATE | Per-job `AbortController`; `cancel(jobId)`; job receives `signal` |
| `src/config.ts` | UPDATE | `AGENT_JOB_TIMEOUT_SECONDS` |
| `src/index.ts` | UPDATE | `runJob()` shared by four tools; register `local_analyze/implement/review/cancel` |
| `src/__tests__/{loop,pool,tools,config,server.e2e}.test.ts` | UPDATE | abort paths, cancel, timeout, new tools |
| `README.md`, `CLAUDE.md` | UPDATE | Tool reference; delegation guidance now names the semantic tools |

## NOT Building

- `local_test_failure` (§7.4, "optional"). `local_analyze` with the failing output pasted into `objective` covers it; add a dedicated tool only if that proves awkward.
- Structured JSON results (§12). Still text with a header line; Phase 6.
- Cancelling *queued* jobs by id (they have none yet); the client abort already dequeues them.
- Inference request timeout distinct from the job timeout (§16 item 2). The job timeout aborts the fetch anyway.
- Streaming (Phase 5) — the abort cancels a non-streaming fetch fine.
- Retention of the worktree after cancel. The partial diff is returned; the tree is removed.
- Per-worker/per-model routing for review ("stronger review model", §18). `model?` override exists on every tool already.
- Changing `run_local_agent`'s default mode.

---

## Step-by-Step Tasks

### Task 0: Branch and baseline
- **ACTION**: `git checkout -b feat/semantic-tools-and-cancel` from `main`; `npm test`.
- **VALIDATE**: 225 pass.

### Task 1: Abort reaches Ollama (test first)
- **ACTION**: `src/__tests__/ollama.test.ts` then `src/ollama.ts`.
- **IMPLEMENT**: Test: mock server that never answers `/api/chat`; `chatWithOllama(url, req, AbortSignal.timeout(100))` rejects with an error whose `name` is `"TimeoutError"` (i.e. the abort is **not** rewrapped as "Ollama is not running"). Code: third param `signal?: AbortSignal`, passed to `fetch`; in the catch, `if (signal?.aborted) throw err;` **before** the existing rewraps.
- **GOTCHA**: undici raises the signal's `reason` — with `AbortSignal.timeout` that is a `DOMException` named `TimeoutError`; with a manual abort it is whatever reason was passed. Rethrow as-is.
- **VALIDATE**: `npx vitest run src/__tests__/ollama.test.ts`.

### Task 2: Abort kills the shell subprocess (test first)
- **ACTION**: `src/__tests__/tools.test.ts` then `src/tools.ts`.
- **IMPLEMENT**: Test (skip on win32): `const c = new AbortController(); const p = executeTool("bash", { command: "sleep 5" }, tempDir, "restricted", [...allowedCommands, "sleep"], 10_000, false, c.signal); setTimeout(() => c.abort(), 100);` → resolves within ~1 s with `success:false`, output contains `"cancelled"`. Code: `bashExec(..., readOnly, signal?)`. Extract the existing kill block into `const kill = () => { ... }` used by both the timer and `signal.addEventListener("abort", onAbort, { once: true })` where `onAbort` sets `cancelled = true` then `kill()`. On `close`: `signal?.removeEventListener("abort", onAbort)`; if `cancelled` resolve `{ success: false, output: "command cancelled" }`. If `signal?.aborted` at entry, resolve that immediately without spawning. `executeTool` gains trailing `signal?: AbortSignal` and forwards it.
- **MIRROR**: existing timer/kill code at tools.ts:283-295.
- **VALIDATE**: tools tests green; the new test finishes in well under 5 s.

### Task 3: Loop stops on abort and reports it (test first)
- **ACTION**: `src/__tests__/loop.test.ts` then `src/loop.ts`.
- **IMPLEMENT**:
  - `AgentResult` gains `aborted?: "cancelled" | "timed_out"`.
  - `runAgentLoop` option `signal?: AbortSignal`. Pass to both `chatWithOllama` calls and to `executeTool`. Wrap the `while` body: at the top of each iteration `if (signal?.aborted) break;`. Wrap the chat call: `try { ... } catch (err) { if (signal?.aborted) break; throw err; }`. After the loop: `const aborted = signal?.aborted ? (signal.reason?.name === "TimeoutError" ? "timed_out" : "cancelled") : undefined;` and return it. When aborted, `finalMessage` stays `""` and `stoppedByLimit` stays false.
  - `export function jobStatus(result: AgentResult): string` → `result.aborted ?? (result.parseFailure ? "parse_failed" : result.stoppedByLimit ? "stopped_at_limit" : "completed")`.
  - `formatAgentResult`: after the `stoppedByLimit` line add `if (result.aborted) logLines.push(\`[${result.aborted === "timed_out" ? "timed out" : "cancelled"} after ${result.iterationCount} iterations]\`)`; the empty-final-message note must not fire when aborted. Header gains ` | status ${jobStatus(result)}` (RunInfo unchanged).
  - Tests: (a) chat mock returns a tool call, then the second chat call rejects with `new DOMException("x", "AbortError")` after `controller.abort()` → result has 1 step, `aborted === "cancelled"`, chat called twice, no throw. (b) Signal already aborted before the call → 0 chat calls, `aborted === "cancelled"`. (c) `AbortSignal.timeout(50)` with a chat mock that waits 200 ms then rejects with `new DOMException("t", "TimeoutError")` → `aborted === "timed_out"`. (d) `jobStatus` table. (e) header contains `status completed` for a normal result and `status cancelled` for an aborted one; the header test from Phase 3 gets `| status completed` appended.
- **GOTCHA**: The chat mock never sees a real signal; the tests abort the controller themselves and make the mock reject. That is fine — Task 1 covers the real fetch path.
- **VALIDATE**: loop tests green.

### Task 4: Pool cancel (test first)
- **ACTION**: `src/__tests__/pool.test.ts` then `src/pool.ts`.
- **IMPLEMENT**:
  - Job signature `job: (worker, jobId, signal: AbortSignal) => Promise<T>`.
  - `execute`: `const controller = new AbortController(); worker.controller = controller;` and if `opts.signal` is given, `AbortSignal.any([controller.signal, opts.signal])` is what the job receives (client disconnect cancels the running job too). Clear `worker.controller` in `release`.
  - `cancel(jobId): { workerId: string } | undefined` — find the worker whose `jobId` matches, `controller.abort(new Error("cancelled by local_cancel"))`, return its id; `undefined` when no such running job.
  - `RunOptions` keeps `signal` (now used for both queued and running).
  - Tests: (a) a `gatedJob` that resolves when its signal aborts (`signal.addEventListener("abort", () => open())`) — after `pool.cancel(jobId)` the job settles and the worker is `idle`; `cancel("nope")` returns `undefined`. Get the `jobId` from `pool.status()`. (b) Aborting the caller's `signal` while the job is *running* aborts the job's signal.
- **GOTCHA**: `AbortSignal.any` needs both signals to be real `AbortSignal`s; guard `opts.signal ? AbortSignal.any([...]) : controller.signal`.
- **VALIDATE**: pool tests green.

### Task 5: Job timeout config (test first)
- **ACTION**: `src/__tests__/config.test.ts` then `src/config.ts`.
- **IMPLEMENT**: `AGENT_JOB_TIMEOUT_SECONDS` → `jobTimeoutMs` (default `900_000`), `parsePositiveInt`, CONF-10, add to `ENV_KEYS`. Tests: default, override, invalid.
- **VALIDATE**: config tests green.

### Task 6: Prompt builders (test first)
- **ACTION**: Create `src/__tests__/prompts.test.ts`, then `src/prompts.ts`.
- **IMPLEMENT**:
  ```ts
  // Prompt builders for the semantic tools. Pure: structured inputs in, worker prompt out.

  export interface AnalyzeInput { objective: string; paths: string[]; constraints?: string[] }
  export interface ImplementInput extends AnalyzeInput { acceptance_criteria: string[]; test_commands: string[] }
  export interface ReviewInput { objective: string; paths?: string[]; diff?: string; review_focus?: string[] }

  const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  const section = (title: string, items?: string[]) => items?.length ? `\n${title}:\n${list(items)}\n` : "";

  export function analyzePrompt(i: AnalyzeInput): string {
    return [
      `Objective: ${i.objective}`,
      section("Scope (read only these paths; use grep/find within them)", i.paths),
      section("Constraints", i.constraints),
      "Report: findings with file:line evidence, then concise conclusions, then open questions.",
    ].join("\n");
  }

  export function implementPrompt(i: ImplementInput): string {
    return [
      `Objective: ${i.objective}`,
      section("Scope (files you may read and change)", i.paths),
      section("Acceptance criteria (all must hold before you finish)", i.acceptance_criteria),
      section("Validation commands (run each with bash; paste the pass/fail result)", i.test_commands),
      section("Constraints", i.constraints),
      "Make the smallest change that satisfies every criterion. If a validation command fails, fix the cause and re-run it. If you cannot satisfy a criterion, say so explicitly instead of claiming success.",
    ].join("\n");
  }

  export function reviewPrompt(i: ReviewInput): string {
    return [
      `Review objective: ${i.objective}`,
      section("Paths to inspect", i.paths),
      section("Focus", i.review_focus),
      i.diff ? `\nDiff under review:\n\`\`\`diff\n${i.diff}\n\`\`\`\n` : "",
      "Read the surrounding code before judging the diff. Report each issue as: severity (high/medium/low), file:line, what is wrong, suggested fix. Then list test gaps, then overall confidence (high/medium/low) with one sentence of reasoning. Report 'no issues found' if that is the honest result.",
    ].join("\n");
  }
  ```
  Tests: each builder includes every provided item; omitted optionals produce no empty section; `reviewPrompt` with `diff` wraps it in a diff fence.
- **MIRROR**: PROMPT_STYLE.
- **VALIDATE**: `npx vitest run src/__tests__/prompts.test.ts`.

### Task 7: `runJob` and the four tools
- **ACTION**: Refactor `src/index.ts`.
- **IMPLEMENT**:
  - Shared zod fragments:
    ```ts
    const jobOptions = {
      worker: z.string().optional().describe(`Run on this worker id (${workerIds}). Omit to use the first free worker.`),
      model: z.string().optional().describe(`Model override (default: ${config.model})`),
      max_iterations: z.number().int().positive().optional().describe(`Tool-call rounds allowed (default ${config.maxIterations})`),
      timeout_seconds: z.number().int().positive().optional().describe(`Job wall-clock limit (default ${config.jobTimeoutMs / 1000}). On expiry the job stops and returns what it has.`),
    };
    ```
  - `async function runJob(args: { prompt: string; mode: Mode; worker?: string; model?: string; max_iterations?: number; timeout_seconds?: number }, clientSignal: AbortSignal): Promise<string>` — the current handler body, with: `maxIterations = args.max_iterations ?? config.maxIterations`; inside the pool job, `signal = AbortSignal.any([jobSignal, AbortSignal.timeout(timeoutMs)])` passed to `runAgentLoop`; `formatAgentResult(result, maxIterations, {...})`. Keep the try/catch semantics (a *thrown* error keeps the worktree; an aborted *result* captures the diff and removes it).
  - `const toolResult = (text: string) => ({ content: [{ type: "text" as const, text }] })` and the existing error shape as `toolError(err)`.
  - Register:
    - `run_local_agent`: unchanged inputs + `jobOptions` (replaces its own `worker`/`model`), calls `runJob`.
    - `local_analyze`: `objective`, `paths: z.array(z.string()).min(1)`, `constraints?: string[]`, + `jobOptions` → `runJob({ prompt: analyzePrompt(a), mode: "analyze", ... })`. Description: "Read-only repository investigation on a local worker: architecture discovery, affected files, dependency tracing, test discovery. Cannot modify files. Safe to run several in parallel."
    - `local_implement`: `objective`, `paths` (min 1), `acceptance_criteria` (min 1), `test_commands: string[]` (may be empty), `constraints?` → mode `implement`. Description: "Bounded implementation on a local worker in an isolated git worktree seeded with your uncommitted changes. Returns a report, changed files and a unified diff — apply it with `git apply`. Never touches your checkout. Safe to run several in parallel."
    - `local_review`: `objective`, `paths?`, `diff?`, `review_focus?` → mode `analyze`. Description: "Independent read-only review of a diff or of existing code on a local worker: issues with severity and file:line, suggested fixes, test gaps, confidence. Cheap way to use a second worker while another implements."
    - `local_cancel`: `job_id: z.string()` → `pool.cancel(job_id)`; text `cancelling job X on worker Y — its result will arrive with status cancelled` or `no running job X (queued jobs have no id yet; job ids appear in local_worker_status)`. Not `isError` either way.
  - Startup line: append `| job timeout: ${config.jobTimeoutMs / 1000}s`.
- **GOTCHA**: `local_review` must validate that at least one of `paths`/`diff` is present (`.refine`) or the worker has nothing to look at. `timeout_seconds` also bounds queue wait? No — start the timeout inside the pool job so queue time does not count (the header's elapsed still includes it).
- **VALIDATE**: `npm run typecheck && npm run lint && npm run build`; existing e2e still green.

### Task 8: E2E for the new tools, cancel, timeout
- **ACTION**: Extend `src/__tests__/server.e2e.test.ts`.
- **IMPLEMENT**: Mock scripting gains a `loop:` prefix: always reply with a `read_file a.txt` tool call (never finishes). Tests:
  - `tools/list` → the six names sorted.
  - `local_analyze({objective:"x", paths:["a.txt"]})` → header has `mode analyze` and `status completed`; the mock saw a user message containing `Objective: x` and `- a.txt`.
  - `local_implement({objective:"write: x", paths:["a.txt"], acceptance_criteria:["worker.txt exists"], test_commands:[]})` → `mode implement`, diff contains `worker.txt`, checkout untouched. (The mock's `write:` trigger looks at `messages[1].content.startsWith("write:")` — change it to `.includes("write:")` so the objective line triggers it.)
  - `local_review({objective:"x", diff:"--- a\n+++ b"})` → `mode analyze`; mock saw the fence.
  - **cancel**: start `run_local_agent({prompt:"loop: x"})` without awaiting; poll `local_worker_status` until a `job_id` appears; `local_cancel({job_id})` → text starts with `cancelling job`; the original call resolves within ~2 s, not `isError`, header `status cancelled`, a `[cancelled after N iterations]` line, N ≥ 1.
  - **timeout**: `run_local_agent({prompt:"loop: x", timeout_seconds: 1})` → resolves in ~1-1.5 s with `status timed_out`.
  - `local_cancel({job_id:"nope"})` → `no running job nope`.
- **GOTCHA**: Wait for the first `[agent] iteration` before cancelling by polling status, not by sleeping. Because `CHAT_DELAY_MS` is 300, a 1 s timeout yields ~3 iterations — assert `≥ 1`, not an exact count.
- **VALIDATE**: e2e green 3× in a row.

### Task 9: Docs
- **ACTION**: `README.md`, `CLAUDE.md`.
- **IMPLEMENT**: README "Tools" table (six tools, inputs, what comes back), `AGENT_JOB_TIMEOUT_SECONDS` row, `status` values, cancellation section (what `local_cancel` stops, that queued jobs are cancelled by the client, partial diff on cancel). CLAUDE.md: rewrite "How to Invoke" around the semantic tools — `local_analyze` for exploration/review prep, `local_implement` with explicit `acceptance_criteria` and `test_commands`, `local_review` on a second worker for non-trivial diffs, `run_local_agent` only for things that fit none; keep the "bounded objective" guidance; add "treat output as untrusted engineering work — inspect the diff, verify critical claims" (§20).
- **GOTCHA**: still model-agnostic, no IPs.
- **VALIDATE**: grep for `192\.168` empty.

### Task 10: Full validation + live check
- **ACTION**: Validation Commands, then Manual Validation.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| ollama abort | timeout signal, hanging server | rejects with `TimeoutError`, not rewrapped | core |
| bash abort | `sleep 5` + abort at 100 ms | resolves fast, "cancelled" | core |
| bash pre-aborted | aborted signal | no spawn, "cancelled" | yes |
| loop cancelled mid-run | abort after 1 step | `aborted:"cancelled"`, steps kept, no throw | core |
| loop timed out | `AbortSignal.timeout` | `aborted:"timed_out"` | yes |
| loop pre-aborted | — | 0 chat calls | yes |
| `jobStatus` | 5 result shapes | 5 statuses | |
| pool cancel | running job id | job settles, worker idle | core |
| pool cancel unknown | `"nope"` | `undefined` | yes |
| pool client abort while running | caller signal | job signal aborted | yes |
| config job timeout | default / `60` / `abc` | 900 000 / 60 000 / `ConfigError` | yes |
| prompts | full / minimal inputs | all items present / no empty sections | yes |
| e2e cancel + timeout | scripted looping mock | `status cancelled` / `status timed_out` | core |

### Edge Cases Checklist
- [x] Empty input — `test_commands: []`, no `constraints`, review with no `paths` but a `diff`
- [x] Invalid types — zod: `paths` min 1, positive ints, `local_review` refine
- [x] Concurrent access — cancel while another job runs on the other worker (e2e runs on two mocks)
- [x] Network failure — abort during a hanging fetch
- [x] Cancellation — running, queued (Phase 2), already finished (`no running job`)
- [ ] Maximum size — unchanged from Phase 3

---

## Validation Commands

### Static Analysis
```bash
npm run typecheck && npm run lint
```

### Unit Tests
```bash
npx vitest run src/__tests__/ollama.test.ts src/__tests__/tools.test.ts src/__tests__/loop.test.ts src/__tests__/pool.test.ts src/__tests__/config.test.ts src/__tests__/prompts.test.ts
```

### Full Test Suite
```bash
npm test && npm run build
```
EXPECT: 225 baseline + new pass; e2e stable 3×

### Manual Validation
Live endpoint in project memory (`ollama-gpu-host`); scratch git clone as `AGENT_WORKING_DIR`.
- [ ] `local_analyze({objective:"Where is the shell allow-list enforced and what does it miss?", paths:["src/security.ts","src/tools.ts"]})` → findings with file:line, `status completed`.
- [ ] `local_implement({objective:"Add a `wc -c`-style byte count to list_dir output", paths:["src/tools.ts"], acceptance_criteria:["list_dir output unchanged except an extra field","npm test passes"], test_commands:["npx vitest run src/__tests__/tools.test.ts"]})` → diff + validation results; `git apply` works on the scratch clone.
- [ ] `local_review({objective:"Review this diff for correctness and style", diff:<the diff from above>})` → issues with severity/file:line or "no issues found".
- [ ] Start `local_implement` with a deliberately long objective, then `local_cancel` from a second stdio call within ~10 s → result comes back with `status cancelled`, steps so far, partial diff; `local_worker_status` shows the worker `idle`; no leftover worktree.
- [ ] `run_local_agent({prompt:"...", timeout_seconds: 5})` on a multi-step task → `status timed_out` after ~5 s.

---

## Acceptance Criteria
(goal doc §27 items this phase closes)
- [ ] Jobs can be cancelled
- [ ] Jobs can time out safely
- [ ] Failed / cancelled / timed-out jobs do not pretend to succeed (status in header)
- [ ] Semantic tools available; `run_local_agent` kept and compatible
- [ ] Supervisor instructions (CLAUDE.md) encourage delegation but retain final verification
- [ ] typecheck, lint, test, build pass

## Completion Checklist
- [ ] Abort reaches fetch and the shell subprocess; no listener leaks
- [ ] Cancel/timeout return results, not errors; worktree diff captured then removed
- [ ] Tool descriptions are client-agnostic (work for Codex too)
- [ ] No real hostnames/IPs in committed files
- [ ] README + CLAUDE.md updated

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ollama keeps generating after the client disconnects (abort only closes our socket) | High | Low | GPU busy for one generation at most; Ollama drops the request when the connection closes for `/api/chat` in current versions — not verified here |
| A cancelled job's shell command had side effects in the worktree | Medium | Low | Partial diff is returned for inspection; worktree removed |
| Supervisor keeps using `run_local_agent` with hand-written prompts | Medium | Low | CLAUDE.md rewritten around the semantic tools; `run_local_agent` description says "prefer local_analyze / local_implement / local_review" |
| `timeout_seconds` shorter than one generation → every job times out | Low | Low | Default 900 s; documented minimum guidance (≥ 60) |
| `AbortSignal.any` unavailable on older Node | Low | Medium | `package.json` engines — add `"node": ">=20.3"` (first version with `AbortSignal.any`) |

## Notes
- Verified while planning: `AbortSignal.any` and `AbortSignal.timeout` exist on this Node; `bashExec` already has a process-group kill; `chatWithOllama` uses `fetch` so a signal is a one-line addition; pool job ids exist only from `execute` on.
- Not verified: whether Ollama aborts generation server-side when the HTTP connection closes; whether Claude Code surfaces a client-side cancel to the MCP server as an abort (Codex behaviour likewise). The `local_cancel` path does not depend on either.
- `local_test_failure` deliberately skipped — see NOT Building.
