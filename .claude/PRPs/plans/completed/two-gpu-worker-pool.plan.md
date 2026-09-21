# Plan: Two-GPU Worker Pool (Goal Doc Phase 2)

## Summary
Let the MCP server drive several Ollama endpoints at once: a `WorkerPool` that gives each job its own worker, runs independent jobs concurrently, queues the rest, checks health before dispatch, and fails over to another worker when one is down. Adds `AGENT_WORKERS` config, an optional `worker` argument on `run_local_agent`, and a `local_worker_status` tool. With no `AGENT_WORKERS` set, behaviour is exactly today's single worker.

## User Story
As a Claude Code / Codex supervisor,
I want two `run_local_agent` calls issued in parallel to run on two different GPUs,
So that independent investigations and reviews finish in half the wall-clock time without overloading either card.

## Problem → Solution
One `OLLAMA_HOST`, no job accounting: two concurrent tool calls both hit the same endpoint, and a dead endpoint is only discovered as a failed job.
→ N configured workers, one job per worker at a time, FIFO queue for the overflow, health probe before every dispatch, visible worker state.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `local-agent-mcp-dual-3090-orchestration-goal.md`
- **PRD Phase**: §28 "Phase 2 — Two-GPU worker pool" (§5, §15 status tool, §17, §18). Phase 1 is complete: `.claude/PRPs/reports/qwen-ready-single-worker-report.md`.
- **Estimated Files**: 10 (4 created, 6 updated)

## Prerequisite on the GPU host — DEFERRED
> 2026-09-21: the user chose to go ahead without a second Ollama instance for now. The pool was built and proven with mock servers and one live endpoint; this section is kept only as the recipe for when GPU 2 comes online. It was deliberately left out of the README.

As of 2026-09-21 the GPU box answers on port 11434 only; nothing listens on 11435. The code in this plan is fully testable without it (mock servers), but the dual-GPU acceptance check needs a second instance. Ollama loads one copy of a model per instance, so two GPUs working independently means two instances:

```ini
# /etc/systemd/system/ollama-gpu1.service  — copy ExecStart/User/Group from `systemctl cat ollama`
[Unit]
Description=Ollama (GPU 1)
After=network-online.target

[Service]
ExecStart=/usr/local/bin/ollama serve
User=ollama
Group=ollama
Restart=always
Environment="CUDA_VISIBLE_DEVICES=1"
Environment="OLLAMA_HOST=0.0.0.0:11435"
Environment="OLLAMA_KEEP_ALIVE=30m"

[Install]
WantedBy=multi-user.target
```
Pin the existing service to the other card with a drop-in (`sudo systemctl edit ollama`): `Environment="CUDA_VISIBLE_DEVICES=0"` and the same `OLLAMA_KEEP_ALIVE`. Then `sudo systemctl daemon-reload && sudo systemctl enable --now ollama-gpu1 && sudo systemctl restart ollama`, and open 11435 in the firewall. Both services run as the same user, so they share one model store — no second download. (`CUDA_VISIBLE_DEVICES`, `OLLAMA_HOST`, `OLLAMA_KEEP_ALIVE` are from memory of Ollama's docs, not re-fetched; the 15.6 s cold load measured in Phase 1 is why keep-alive matters.)

---

## UX Design

### Before
```
supervisor ──┬─ run_local_agent(A) ─┐
             └─ run_local_agent(B) ─┴─> OLLAMA_HOST (one GPU; A and B contend,
                                                     second GPU idle)
```

### After
```
supervisor ──┬─ run_local_agent(A) ─> pool ─> gpu0  [worker gpu0 | ... | 17.8s]
             ├─ run_local_agent(B) ─> pool ─> gpu1  [worker gpu1 | ... | 9.6s]
             ├─ run_local_agent(C) ─> pool ─> queued, runs on whichever frees first
             └─ local_worker_status ─> {"workers":[{id,status,model,job_id?}],"queued":1}
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Config | `OLLAMA_HOST` | `AGENT_WORKERS=gpu0=http://h:11434,gpu1=http://h:11435`; `OLLAMA_HOST` still works alone | unset → one worker named `default` |
| `run_local_agent` input | `prompt`, `model?` | + `worker?` (explicit id, for diagnostics) | additive, backward compatible |
| `run_local_agent` output | report | first line `[worker <id> \| <model> \| job <id> \| <s>s \| <n> iterations]` then the same report | lets the supervisor see placement |
| New tool | — | `local_worker_status` | live-probes idle workers |
| Dead endpoint | job fails after the fact | skipped at dispatch, next worker used; `unhealthy` in status | no mid-job retry (see NOT Building) |
| Client cancels a queued call | n/a | waiter removed from the queue | uses the SDK's per-request `signal` |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/index.ts` | 12-86 | Tool registration, handler shape, error return, startup line — all change |
| P0 | `src/config.ts` | 26-107 | `AppConfig`, `parsePositiveInt`, `ConfigError`, CONF-nn comments |
| P0 | `src/loop.ts` | 53-113 | `runAgentLoop` already takes `host` and `model` per call — the pool passes them in, the loop does not change |
| P1 | `src/ollama.ts` | 44-76 | fetch + error style to mirror in `checkHealth` |
| P1 | `src/parser.ts` | 14, 366-402 | `ChatFn` — the codebase's pattern for injecting a network dependency so tests need no mocks |
| P2 | `src/__tests__/loop.test.ts` | 1-48 | vitest setup/teardown style |
| P2 | `src/__tests__/config.test.ts` | 9-66 | `ENV_KEYS` snapshot; tests that read `config.ollamaHost` must move to `config.workers` |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| MCP SDK request dispatch | `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:280-363` (v1.27.1, read 2026-09-21) | `_onrequest` starts each handler as an un-awaited promise, so concurrent `tools/call` requests run concurrently in one server process. The handler's second argument carries `signal: abortController.signal` (line 315), aborted when the client cancels. |
| Ollama health | `GET /api/version` returns `{"version":"0.34.2"}` — verified live | Cheap liveness probe (2 ms on the LAN); does not load a model |

```
KEY_INSIGHT: The server is already concurrent; nothing serialises tool calls today.
APPLIES_TO: Tasks 5-8
GOTCHA: That means two jobs can already hit one GPU at once. The pool is what adds per-worker serialisation.

KEY_INSIGHT: Claiming a worker must be synchronous — set status "busy" BEFORE the first await.
APPLIES_TO: Task 6
GOTCHA: If the health probe is awaited before the claim, two concurrent calls both see gpu0 idle and both take it.

KEY_INSIGHT: The SDK's DEFAULT_REQUEST_TIMEOUT_MSEC (60 s) is a client-side default for requests the SDK sends; how long Claude Code / Codex wait for a tool result is set by the client, not here.
APPLIES_TO: Risks
GOTCHA: A job queued behind a long job may outlive the client's patience. The abort-signal handling keeps such a job from occupying a GPU after the client gave up while it is still queued.
```

---

## Patterns to Mirror

### NAMING_CONVENTION
// SOURCE: src/config.ts:15-20, src/loop.ts:15-27
PascalCase classes/interfaces, camelCase functions, SCREAMING_SNAKE constants, `.js` on relative imports, `node:` on builtins, section banners.
```ts
export class ConfigError extends Error {
  constructor(envKey: string, value: string, expected: string) {
    super(`${envKey}=${value} is not valid, expected: ${expected}`);
    this.name = "ConfigError";
  }
}
```

### ERROR_HANDLING
// SOURCE: src/index.ts:61-71
Tool handlers never throw to the transport; they return `isError: true` with `Error: <message>`.
```ts
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
```

### LOGGING_PATTERN
// SOURCE: src/loop.ts (iteration log), eslint.config.js
stdout is the MCP transport — `console.error` only, bracketed tag prefix.
```ts
    console.error(`[agent] iteration ${iteration}: ${toolCalls.length} tool call(s)`);
```
Pool logs use `[pool]`.

### DEPENDENCY_INJECTION_PATTERN
// SOURCE: src/parser.ts:14, 366-369
Network calls are injected as a function argument so unit tests pass a fake — no module mocking needed.
```ts
export type ChatFn = (messages: OllamaMessage[]) => Promise<OllamaMessage>;

export async function parseToolCall(
  content: string,
  chatFn: ChatFn,
): Promise<OllamaToolCall[] | ParseFailure> {
```
`WorkerPool` takes `healthFn: HealthFn = checkHealth` the same way.

### CONFIG_PATTERN
// SOURCE: src/config.ts:60-61, 76-81
```ts
  // CONF-01
  const ollamaHost = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  ...
  if (!VALID_SHELL_MODES.includes(rawShellMode as ShellMode)) {
    throw new ConfigError("AGENT_SHELL_MODE", rawShellMode, "restricted | full | none");
  }
```

### TEST_STRUCTURE
// SOURCE: src/__tests__/loop.test.ts:40-48
```ts
beforeEach(async () => {
  chat.mockReset();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-test-"));
  await fs.writeFile(path.join(tempDir, "test.txt"), "hello world", "utf-8");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});
```

---

## Files to Change

| File | Action | Responsibility |
|---|---|---|
| `src/pool.ts` | CREATE | `WorkerPool`: claim/queue/release, health-gated dispatch, status snapshot |
| `src/__tests__/pool.test.ts` | CREATE | Scheduler unit tests with a fake `healthFn` |
| `src/__tests__/ollama.test.ts` | CREATE | `checkHealth` against a real `node:http` server |
| `src/__tests__/server.e2e.test.ts` | CREATE | Spawns the server with two mock Ollama servers; 3 concurrent calls |
| `src/config.ts` | UPDATE | `WorkerConfig`, `AGENT_WORKERS` parsing; `workers` replaces `ollamaHost` |
| `src/ollama.ts` | UPDATE | `checkHealth(host)` |
| `src/index.ts` | UPDATE | Build the pool; `worker` arg; header line; abort signal; `local_worker_status` |
| `src/__tests__/config.test.ts` | UPDATE | `AGENT_WORKERS` cases; `ollamaHost` assertions → `workers` |
| `README.md` | UPDATE | `AGENT_WORKERS`, dual-GPU setup, status tool |
| `CLAUDE.md` | UPDATE | Parallel delegation guidance and the concurrent-writer warning |

## NOT Building

- **Mid-job retry on another worker.** A job that has already run tools may have written files; replaying it elsewhere repeats side effects. Failover happens only at dispatch, before any work.
- **Worktree isolation / read-only profiles (Phase 3).** Until then two *write* jobs in parallel share one checkout. This plan documents that in the tool description and `CLAUDE.md`; it does not try to detect it.
- `local_analyze` / `local_implement` / `local_review` / `local_cancel` (Phase 4). Cancelling a *running* job is Phase 4; only queued jobs react to the abort signal here.
- Provider interface / OpenAI-compatible endpoints (Phase 5). `WorkerConfig` has no `provider` field yet.
- YAML config file (§24). One env var covers two workers.
- Per-worker model syntax in `AGENT_WORKERS`. `WorkerConfig.model` exists so the scheduler never assumes identical models (§18), but every worker gets `AGENT_MODEL` for now. Add syntax when a second model is actually deployed.
- `max_concurrency` > 1, routing policies beyond first-idle, `disabled` state, background health timers, queue length limits, metrics, persisted job records (Phase 6). Job ids exist only so status can name the running job.

---

## Step-by-Step Tasks

### Task 0: Branch and baseline
- **ACTION**: `git checkout -b feat/two-gpu-worker-pool` from `main`; `npm test`.
- **VALIDATE**: 114 tests pass; `npm run typecheck && npm run lint` clean.

### Task 1: Failing config tests for workers
- **ACTION**: Update `src/__tests__/config.test.ts`.
- **IMPLEMENT**: add `"AGENT_WORKERS"` to `ENV_KEYS`. Cases:
  1. defaults → `config.workers` equals `[{ id: "default", host: "http://localhost:11434", model: "qwen2.5-coder:7b" }]`;
  2. `OLLAMA_HOST=http://custom:1234` → `workers[0].host === "http://custom:1234"` (replaces the old `ollamaHost` test);
  3. `AGENT_WORKERS="gpu0=http://a:11434, gpu1=http://a:11435/"` + `AGENT_MODEL=m` → two workers, whitespace trimmed, trailing slash stripped, both `model: "m"`;
  4. `AGENT_WORKERS` set **and** `OLLAMA_HOST` set → `AGENT_WORKERS` wins;
  5. each throws `ConfigError`: `"gpu0"` (no `=`), `"=http://a:1"` (empty id), `"gpu 0=http://a:1"` (bad id), `"gpu0=notaurl"`, `"gpu0=ftp://a:1"`, `"gpu0=http://a:1,gpu0=http://b:1"` (duplicate id), `""` (empty).
  Remove the `config.ollamaHost` assertion from the defaults test.
- **MIRROR**: TEST_STRUCTURE (`setup({...})` helper at config.test.ts:45-53).
- **VALIDATE**: `npx vitest run src/__tests__/config.test.ts` — new cases fail.

### Task 2: Implement `AGENT_WORKERS`
- **ACTION**: Update `src/config.ts`; one-line compile fix in `src/index.ts`.
- **IMPLEMENT**:
  ```ts
  export interface WorkerConfig {
    id: string;
    host: string;
    model: string;
  }
  ```
  `AppConfig`: replace `ollamaHost: string` with `workers: readonly WorkerConfig[]`. Add:
  ```ts
  const WORKER_ID = /^[\w-]+$/;

  function parseWorkers(raw: string, model: string): WorkerConfig[] {
    const expected = "id=http://host:port[,id=http://host:port...]";
    const workers: WorkerConfig[] = [];
    for (const entry of raw.split(",").map((s) => s.trim())) {
      const eq = entry.indexOf("=");
      const id = entry.slice(0, eq).trim();
      const url = entry.slice(eq + 1).trim();
      let parsed: URL | undefined;
      try { parsed = new URL(url); } catch { /* reported below */ }
      if (
        eq < 1 || !WORKER_ID.test(id) || !parsed ||
        !["http:", "https:"].includes(parsed.protocol) ||
        workers.some((w) => w.id === id)
      ) {
        throw new ConfigError("AGENT_WORKERS", raw, expected);
      }
      workers.push({ id, host: url.replace(/\/+$/, ""), model });
    }
    return workers;
  }
  ```
  In `loadConfig` (after `model`):
  ```ts
  // CONF-01 / CONF-09: AGENT_WORKERS wins; OLLAMA_HOST alone means one worker
  const rawWorkers = process.env.AGENT_WORKERS;
  const workers =
    rawWorkers !== undefined
      ? parseWorkers(rawWorkers, model)
      : [{ id: "default", host: process.env.OLLAMA_HOST ?? "http://localhost:11434", model }];
  ```
  Header comment → "CONF-01 through CONF-09". In `index.ts` temporarily use `host: config.workers[0]!.host` and the same in the startup line so the build stays green until Task 8.
- **GOTCHA**: `"".split(",")` yields `[""]`, whose `indexOf("=")` is `-1` → the `eq < 1` check rejects it; no separate empty check needed. Split on the **first** `=` only — URLs may contain `=` in a query string.
- **VALIDATE**: config tests green; `npm run typecheck`.

### Task 3: `checkHealth` test
- **ACTION**: Create `src/__tests__/ollama.test.ts`.
- **IMPLEMENT**: start a `node:http` server on port 0 that answers `GET /api/version` with `{"version":"mock"}`; expect `checkHealth(url)` → `true`. A server answering 500 → `false`. A closed port (start a server, read its port, close it) → `false`. A server that never responds → `false` within ~timeout (pass a 200 ms timeout to keep the test fast).
  ```ts
  function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }>
  ```
  Put this helper in the test file; Task 9 has its own copy (two uses do not justify a shared test-utils module).
- **VALIDATE**: fails — `checkHealth` is not exported.

### Task 4: Implement `checkHealth`
- **ACTION**: Update `src/ollama.ts`.
- **IMPLEMENT**:
  ```ts
  const HEALTH_TIMEOUT_MS = 3000;

  /** Liveness probe. Never throws; does not load a model. */
  export async function checkHealth(host: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
    try {
      const resp = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
      return resp.ok;
    } catch {
      return false;
    }
  }
  ```
- **GOTCHA**: ESLint's `preserve-caught-error` only fires when a *new* error is thrown from a catch; a bare `catch {}` returning `false` is fine.
- **VALIDATE**: `npx vitest run src/__tests__/ollama.test.ts` green.

### Task 5: Failing pool tests
- **ACTION**: Create `src/__tests__/pool.test.ts`.
- **IMPLEMENT**: helpers —
  ```ts
  const W = [
    { id: "gpu0", host: "http://a", model: "m" },
    { id: "gpu1", host: "http://b", model: "m" },
  ];
  // A job that stays running until released by the test
  function gate() { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; }
  const healthy = async () => true;
  ```
  Cases:
  1. **Two jobs → two workers, concurrently**: start two gated jobs; after a `await Promise.resolve()` tick both jobs have started and saw different `worker.id`s.
  2. **Third job queues, then runs on the first freed worker**: with both busy, a third job has not started; open gpu1's gate → third starts on `gpu1`.
  3. **FIFO**: jobs 3 and 4 queued; freeing one worker starts job 3, not 4.
  4. **Explicit worker**: `{ workerId: "gpu1" }` while gpu1 is busy and gpu0 idle → waits for gpu1.
  5. **Explicit waiter is not starved / does not block others**: queue `[X→gpu1, Y→any]`; gpu0 frees → Y runs on gpu0, X still waits.
  6. **Unknown worker id** → rejects with `/unknown worker: nope \(known: gpu0, gpu1\)/`, job never called.
  7. **Failover at dispatch**: `healthFn = async (h) => h !== "http://a"` → job runs on `gpu1`; `status()` shows gpu0 `unhealthy`.
  8. **All unhealthy** → rejects `/no healthy worker/`; job never called.
  9. **Recovery**: healthFn false then true for gpu0 → second `run` succeeds on gpu0, status `idle` afterwards.
  10. **Job throws** → `run` rejects with the same error and the worker is `idle` again (next job runs).
  11. **Abort while queued**: both busy, third `run` with an `AbortController().signal`; abort → rejects `/cancelled/`; when a worker frees, the aborted job is never called and `status().queued === 0`.
  12. **No double-claim**: `healthFn` that resolves after `setTimeout(10)`; start two runs in the same tick → they get different workers.
  13. **Status**: busy worker reports `job_id` and `busy_seconds`; idle worker has neither.
- **MIRROR**: DEPENDENCY_INJECTION_PATTERN — pass `healthFn`, no `vi.mock`.
- **VALIDATE**: fails — `../pool.js` does not exist.

### Task 6: Implement `WorkerPool`
- **ACTION**: Create `src/pool.ts`.
- **IMPLEMENT**:
  ```ts
  // Worker pool — one job per worker at a time, FIFO queue for the rest.
  // Health is probed at dispatch only: no timers, no background state.

  import { randomUUID } from "node:crypto";
  import { checkHealth } from "./ollama.js";
  import type { WorkerConfig } from "./config.js";

  export type WorkerStatus = "idle" | "busy" | "unhealthy";
  export type HealthFn = (host: string) => Promise<boolean>;

  export interface WorkerSnapshot {
    id: string;
    status: WorkerStatus;
    model: string;
    job_id?: string;
    busy_seconds?: number;
  }

  interface WorkerState extends WorkerConfig {
    status: WorkerStatus;
    jobId?: string;
    busySince?: number;
  }

  interface Waiter {
    workerId?: string;
    resolve: (worker: WorkerState) => void;
  }
  ```
  `class WorkerPool { constructor(configs: readonly WorkerConfig[], private readonly healthFn: HealthFn = checkHealth) }` holding `workers: WorkerState[]` (all `idle`) and `queue: Waiter[]`.

  `run<T>(job: (worker: WorkerConfig, jobId: string) => Promise<T>, opts: { workerId?: string; signal?: AbortSignal } = {}): Promise<T>`:
  ```ts
  if (opts.workerId && !this.workers.some((w) => w.id === opts.workerId)) {
    throw new Error(`unknown worker: ${opts.workerId} (known: ${this.workers.map((w) => w.id).join(", ")})`);
  }
  for (;;) {
    // Probe each free candidate once per pass; a worker handed over from the queue is probed too.
    const tried = new Set<string>();
    let worker = this.claim(opts.workerId, tried);
    while (worker) {
      if (await this.healthFn(worker.host)) return await this.execute(worker, job);
      console.error(`[pool] worker ${worker.id} unhealthy at ${worker.host}`);
      tried.add(worker.id);
      this.release(worker, "unhealthy");
      worker = this.claim(opts.workerId, tried);
    }
    if (!this.candidates(opts.workerId).some((w) => w.status === "busy")) {
      throw new Error("no healthy worker available -- check local_worker_status");
    }
    worker = await this.enqueue(opts.workerId, opts.signal);
    if (await this.healthFn(worker.host)) return await this.execute(worker, job);
    this.release(worker, "unhealthy");
  }
  ```
  - `candidates(id)`: all workers, or the one with that id.
  - `claim(id, tried)`: **synchronous**. First candidate with `status !== "busy"` and not in `tried`; set `status = "busy"` and return it; else `undefined`.
  - `execute(worker, job)`: set `jobId = randomUUID().slice(0, 8)`, `busySince = Date.now()`; `try { return await job({ id, host, model }, jobId); } finally { this.release(worker, "idle"); }`.
  - `release(worker, status)`: clear `jobId`/`busySince`, set `status`; then find the first waiter with `workerId === undefined || workerId === worker.id`; if found, splice it out, set `worker.status = "busy"`, `resolve(worker)`.
  - `enqueue(id, signal)`: `new Promise((resolve, reject) => { ... })` pushing `{ workerId: id, resolve }`; if `signal?.aborted` reject immediately; else `signal?.addEventListener("abort", () => { remove this waiter if still queued; reject(new Error("cancelled while queued")) }, { once: true })`.
  - `status(): Promise<{ workers: WorkerSnapshot[]; queued: number }>`: probe every non-busy worker in parallel; after each probe, write `idle`/`unhealthy` **only if the worker is still not busy** (a job may have claimed it during the await). Build snapshots; `busy_seconds = Math.round((Date.now() - busySince) / 1000)`.
- **MIRROR**: NAMING_CONVENTION, LOGGING_PATTERN, DEPENDENCY_INJECTION_PATTERN.
- **GOTCHA**:
  - `claim` must not `await` anything before setting `busy` (test 12).
  - `release(worker, "unhealthy")` still hands the worker to a waiter. That waiter probes, fails, releases, and falls through to the "no healthy worker" check — the queue drains itself instead of hanging when the last worker dies.
  - A job that throws releases as `idle`, not `unhealthy`: most job errors are not outages, and the next dispatch probes anyway.
  - Snapshot keys are snake_case on purpose — they are the JSON the supervisor sees (goal doc §15).
- **VALIDATE**: `npx vitest run src/__tests__/pool.test.ts` — all 13 green. `npm run typecheck && npm run lint`.

### Task 7: Report header (test first)
- **ACTION**: Add to `src/__tests__/loop.test.ts`, then `src/loop.ts`.
- **IMPLEMENT**: `formatAgentResult(result, maxIterations, run?: { workerId: string; model: string; jobId: string; elapsedMs: number })`. When `run` is given, prepend `[worker gpu0 | qwen3.8:27b | job 3f2a1c9e | 17.8s | 3 iterations]\n`. Test: header present with `run`, absent without (existing tests untouched).
- **VALIDATE**: loop tests green.

### Task 8: Wire the server
- **ACTION**: Update `src/index.ts`.
- **IMPLEMENT**:
  - `const pool = new WorkerPool(config.workers);`
  - `run_local_agent` input adds `worker: z.string().optional().describe(\`Run on this worker id (${config.workers.map((w) => w.id).join(", ")}). Omit to use the first free worker.\`)`. Model describe → `default: ${config.model}`.
  - Description append: " Calls may be issued in parallel — each runs on its own worker and extra calls queue. Until worktree isolation lands, do not run two file-modifying tasks in parallel on the same checkout."
  - Handler signature `async ({ prompt, model, worker }, extra) =>`; body:
    ```ts
    const started = Date.now();
    const responseText = await pool.run(
      async (w, jobId) => {
        const result = await runAgentLoop({ prompt, model: model ?? w.model, host: w.host, /* rest unchanged */ });
        return formatAgentResult(result, config.maxIterations, {
          workerId: w.id, model: model ?? w.model, jobId, elapsedMs: Date.now() - started,
        });
      },
      { workerId: worker, signal: extra.signal },
    );
    ```
    Existing try/catch and `isError` return stay as they are.
  - New tool:
    ```ts
    server.registerTool(
      "local_worker_status",
      { description: "Show each local worker's state (idle, busy, unhealthy), its model, the running job id, and how many jobs are queued. Idle workers are probed live.", inputSchema: {} },
      async () => ({ content: [{ type: "text" as const, text: JSON.stringify(await pool.status(), null, 2) }] }),
    );
    ```
  - Startup line: replace `host: ...` with `workers: ${config.workers.map((w) => `${w.id}=${w.host}`).join(", ")}`.
- **GOTCHA**: `elapsedMs` measured from handler entry includes queue wait — intended; that is the latency the supervisor experienced. `extra.signal` exists in SDK 1.27.1 (`protocol.js:315`).
- **VALIDATE**: `npm run typecheck && npm run lint && npm run build`.

### Task 9: End-to-end test with mock inference servers
- **ACTION**: Create `src/__tests__/server.e2e.test.ts`.
- **IMPLEMENT**:
  - Two `node:http` mock servers (port 0). `GET /api/version` → 200. `POST /api/chat` → track `inFlight`/`maxInFlight`, wait `CHAT_DELAY_MS = 300`, reply `{"message":{"role":"assistant","content":"done"},"done":true}`.
  - Spawn `process.execPath` with `["--import", "tsx", "src/index.ts"]`, env: `{ ...process.env, AGENT_WORKERS: \`gpu0=${a.url},gpu1=${b.url}\`, AGENT_MODEL: "m", AGENT_WORKING_DIR: tempDir }`. Verified 2026-09-21 that this start command works in this checkout.
  - Minimal JSON-RPC client over stdio: write newline-delimited messages; resolve a `Map<id, resolver>` from parsed stdout lines. Send `initialize`, `notifications/initialized`.
  - **Test A**: send 3 `tools/call` `run_local_agent` without awaiting between them. Expect: each mock's `maxInFlight === 1`; both mocks received ≥ 1 chat; headers name both `gpu0` and `gpu1`; total elapsed ≥ `2 * CHAT_DELAY_MS - 50` and < `3 * CHAT_DELAY_MS + 400` (two parallel, one queued).
  - **Test B**: `local_worker_status` while idle → both `idle`, `queued: 0`. Close mock B, call again → gpu1 `unhealthy`. A `run_local_agent` call then succeeds with header `worker gpu0`.
  - **Test C**: `worker: "nope"` → `isError: true`, text contains `unknown worker`.
  - `afterAll`: kill the child, close mocks, remove tempDir. Give the suite `{ timeout: 20_000 }`.
- **GOTCHA**: `vitest.config.ts` includes `src/**/*.test.ts`, so `*.e2e.test.ts` is picked up by `npm test` — no config change. The child must inherit `PATH`. Assert on timing bounds loosely; CI machines stall.
- **VALIDATE**: `npx vitest run src/__tests__/server.e2e.test.ts` green, 3 times in a row (flakiness check).

### Task 10: Docs
- **ACTION**: Update `README.md`, `CLAUDE.md`.
- **IMPLEMENT**:
  - README config table: row `AGENT_WORKERS | *(unset)* | Comma-separated id=url list of Ollama endpoints, one job per worker at a time. Overrides OLLAMA_HOST.`; note on `OLLAMA_HOST` that it defines the single `default` worker. New section "Two GPUs" with the systemd units from this plan's Prerequisite section, an `env` example using `http://<gpu-host>:11434` / `:11435` placeholders, and `local_worker_status` sample output. Troubleshooting entry: "no healthy worker available".
  - CLAUDE.md: under Efficiency Rules add — issue independent read-only tasks (exploration, review, run-and-report) as parallel `run_local_agent` calls; never run two file-modifying tasks in parallel on the same checkout; check `local_worker_status` when a call errors with "no healthy worker".
- **GOTCHA**: No real IPs or hostnames in committed files (user's global rule; the repo is public). `CLAUDE.md` stays model-agnostic.
- **VALIDATE**: `grep -rn "192\.168" README.md CLAUDE.md src .claude/PRPs` returns nothing.

### Task 11: Full validation + live check
- **ACTION**: Run Validation Commands, then Manual Validation.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| workers default | no env | one worker `default` @ localhost | |
| workers parse | two entries, spaces, trailing slash | two clean entries | yes |
| workers invalid ×7 | see Task 1 | `ConfigError` | yes |
| health ok / 500 / refused / hang | mock http | true / false / false / false | yes |
| pool parallel | 2 jobs | different workers, both running | core |
| pool queue + FIFO | 4 jobs | order preserved | core |
| pool explicit worker | busy target | waits for it; others not blocked | yes |
| pool failover | gpu0 down | runs on gpu1, gpu0 `unhealthy` | yes |
| pool all down | — | "no healthy worker", job not called | yes |
| pool recovery | down then up | back to `idle` | yes |
| pool job throws | — | worker freed | yes |
| pool abort queued | abort signal | rejected, dequeued, never runs | yes |
| pool double-claim | slow health, same tick | different workers | yes (race) |
| e2e 3 concurrent calls | mock servers | 2 parallel + 1 queued, `maxInFlight === 1` | core |

### Edge Cases Checklist
- [x] Empty input — `AGENT_WORKERS=""`
- [x] Invalid types — malformed entries, bad scheme, duplicate ids
- [x] Concurrent access — double-claim race, status probe vs claim
- [x] Network failure — refused, 500, hang, worker dying between jobs
- [x] Cancellation — abort while queued
- [ ] Maximum size — queue is unbounded by design (see NOT Building)

---

## Validation Commands

### Static Analysis
```bash
npm run typecheck && npm run lint
```
EXPECT: zero errors

### Unit Tests
```bash
npx vitest run src/__tests__/config.test.ts src/__tests__/ollama.test.ts src/__tests__/pool.test.ts src/__tests__/loop.test.ts
```
EXPECT: all pass

### Full Test Suite
```bash
npm test && npm run build
```
EXPECT: 114 baseline + new tests pass; `build/index.js` emitted

### Manual Validation
Use a scratch copy of the repo as `AGENT_WORKING_DIR`, never the real checkout. The live endpoint is recorded in project memory (`ollama-gpu-host`), not in this file.
- [ ] **Single worker, unchanged config** (`OLLAMA_HOST` only): the Phase 1 read-only job still works; header shows `worker default`.
- [ ] **One real + one dead worker** (`AGENT_WORKERS=gpu0=<live>,gpu1=<live host>:11435` before the second instance exists): job runs on gpu0; `local_worker_status` shows gpu1 `unhealthy`. Two parallel jobs → second queues behind the first, both succeed.
- [ ] **After the host prerequisite**: two parallel read-only jobs (e.g. "list exports of src/security.ts" and "list exports of src/parser.ts") → headers show `gpu0` and `gpu1`; wall-clock ≈ the slower job, not the sum; `nvidia-smi` on the host shows both GPUs active; `local_worker_status` mid-run shows both `busy`.
- [ ] Third parallel job queues and completes.

---

## Acceptance Criteria
(goal doc §27 items this phase closes)
- [ ] Two model instances can be configured
- [ ] Each worker is routed to a separate inference endpoint
- [ ] Two independent jobs execute concurrently
- [ ] A third job queues rather than overloading a worker
- [ ] Backend health is visible; worker status is queryable
- [ ] Existing single-worker `run_local_agent` usage remains compatible
- [ ] typecheck, lint, test, build all pass

## Completion Checklist
- [ ] Code follows discovered patterns (injected `healthFn`, `[pool]` stderr logs, `ConfigError`)
- [ ] No timers or background state in the pool
- [ ] No real hostnames/IPs in committed files
- [ ] README and CLAUDE.md updated, including the concurrent-writer warning
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Supervisor runs two write jobs in parallel on one checkout | Medium | High | Tool description + CLAUDE.md warn now; Phase 3 (worktrees) is the real fix and should follow immediately |
| Client times out a call that sat in the queue | Medium | Medium | Header shows total elapsed; abort signal dequeues abandoned calls; keep delegated jobs bounded |
| Claude Code / Codex do not actually issue MCP calls in parallel | Low-Medium | Medium | Server side is proven by the e2e test; observe in manual validation. If the client serialises, the pool still gives failover and status. |
| e2e timing assertions flake on a loaded machine | Medium | Low | Loose bounds; primary assertions are `maxInFlight === 1` and both workers used |
| 3 s health timeout per dead worker adds latency to every dispatch while it is down | Low | Low | Acceptable for two workers; add a cool-down if a worker is expected to stay down for long |
| Second Ollama instance not pinned correctly, both load on one GPU | Medium | Medium | Manual check with `nvidia-smi`; documented units set `CUDA_VISIBLE_DEVICES` per service |

## Notes
- The agent loop does not change: `runAgentLoop` already takes `host` and `model` per call, which is why this phase is mostly one new file.
- Verified while planning: SDK handlers run concurrently and receive `extra.signal` (read the installed SDK source); `node --import tsx src/index.ts` starts the server in this checkout; the GPU host has no listener on 11435 yet. Not verified: whether Claude Code issues parallel calls to one MCP server; the systemd/env details for the second instance (from memory).
- Recommend running `claude-memory-init` before or right after this phase — the work now spans sessions and there is no `.claude/STATE.md`.
