# Plan: Provider Abstraction (Goal Doc Phase 5)

## Summary
Put a small `InferenceProvider` interface between the agent loop and the wire protocol, keep the Ollama client as one implementation, and add an OpenAI-compatible one so llama.cpp, vLLM, LM Studio — and Ollama's own `/v1` — can serve workers. Provider is chosen per worker from its URL (`…/v1` → OpenAI-compatible). The loop, pool, parser and tools do not learn anything provider-specific.

## User Story
As the operator of the GPU box,
I want to point a worker at `http://host:8001/v1` (vLLM/llama.cpp) instead of Ollama,
So that I can benchmark backends and pick the fastest one without touching the MCP layer.

## Problem → Solution
`loop.ts` calls `chatWithOllama(host, …)` directly and `pool.ts` probes `GET /api/version`; the message types are Ollama's; a worker is a `{id, host, model}` with Ollama assumed.
→ `WorkerConfig.provider`, `createProvider(worker)` returning `{ chat(request, signal), health() }`, an `OpenAIProvider` that translates messages/tool calls both ways, and the loop/pool taking a provider instead of a host.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `local-agent-mcp-dual-3090-orchestration-goal.md`
- **PRD Phase**: §28 "Phase 5 — Provider abstraction" (§6). Phases 1-4 complete.
- **Estimated Files**: 11 (2 created, 9 updated)

---

## UX Design

### Before
```
AGENT_WORKERS=gpu0=http://host:11434            (Ollama only)
```

### After
```
AGENT_WORKERS=gpu0=http://host:11434,gpu1=http://host:8001/v1
                    └─ ollama (/api/chat)        └─ openai-compatible (/v1/chat/completions)
local_worker_status → { "id": "gpu1", "provider": "openai", ... }
header              → [worker gpu1 | qwen3.8-27b | ...]   (unchanged)
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `AGENT_WORKERS` / `OLLAMA_HOST` | URL = Ollama base | URL ending in `/v1` selects the OpenAI-compatible provider; anything else is Ollama | no new env var |
| `local_worker_status` | `id, status, model` | + `provider` | |
| `AGENT_NUM_CTX` on an OpenAI worker | n/a | ignored (context is a server-side setting there); logged once at startup | |
| Error text | "Ollama is not running at …" | provider-specific: "Ollama is not running at … (ollama serve)" / "no OpenAI-compatible server at …" | |
| Everything else | — | unchanged | tools, modes, cancel, headers |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/ollama.ts` | 1-101 | Types that become the internal chat format; `chatWithOllama`/`checkHealth` become `OllamaProvider` |
| P0 | `src/loop.ts` | 84-165, 199-210 | The two chat call sites and the tool-result push (needs `tool_call_id`) |
| P0 | `src/pool.ts` | 14, 56-62, 82-94, 113-118 | `HealthFn(host)` → takes the worker |
| P1 | `src/index.ts` | 46-90 | `runJob` builds the provider per job |
| P1 | `src/config.ts` | 26-30, 62-84 | `WorkerConfig`, `parseWorkers` |
| P2 | `src/__tests__/loop.test.ts` | 1-22 | `vi.mock("../ollama.js")` — becomes a fake provider object instead |
| P2 | `src/__tests__/ollama.test.ts` | 1-35 | `listen()` mock-server helper to reuse for the OpenAI tests |
| P2 | `src/__tests__/server.e2e.test.ts` | 24-80 | mock Ollama; an OpenAI-shaped mock is added beside it |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| OpenAI chat completions | openai-openapi `openapi.yaml` (fetched 2026-09-21) | Request assistant `tool_calls[].function.arguments` is a **JSON string**; tool result is `{role:"tool", tool_call_id, content}`; response message at `choices[0].message`, `content` may be `null`; JSON mode `response_format: {type:"json_object"}`; `usage.prompt_tokens/completion_tokens`; `finish_reason` `stop`/`tool_calls` |
| Ollama `/v1` live probe | `GET /v1/models`, `POST /v1/chat/completions` against the GPU host, 2026-09-21 | Same shape as above, plus a `reasoning` field on the message and `index` on each tool call; `id` like `call_tsxjsuwx` |

```
KEY_INSIGHT: The only two-way translation is tool calls: arguments object ⇄ JSON string, and tool results need the call's `id` echoed as `tool_call_id`.
APPLIES_TO: Tasks 3, 5
GOTCHA: Ollama's native API does not require an id, so the loop must tolerate calls without one; the OpenAI provider must invent one (`call_<n>`) for text-extracted calls so the follow-up tool message is valid.

KEY_INSIGHT: `content: null` in OpenAI responses would break `classifyText(content)`.
APPLIES_TO: Task 3
GOTCHA: Normalise to "" in the provider, never in the loop.

KEY_INSIGHT: A message with tool_calls must carry `arguments` as a string when SENT back to an OpenAI server, but the loop keeps the object form in history.
APPLIES_TO: Task 3
GOTCHA: Translate on the way out on every request (the whole history), not once at receipt.

KEY_INSIGHT: `GET {base}/models` is the cheapest OpenAI-compatible liveness probe; vLLM, llama.cpp server and LM Studio all serve it.
APPLIES_TO: Task 3
GOTCHA: Some servers require an `Authorization: Bearer` header even locally; support `AGENT_API_KEY` (optional, sent when set).
```

---

## Patterns to Mirror

### DEPENDENCY_INJECTION_PATTERN
// SOURCE: src/pool.ts:56-62
```ts
  constructor(
    configs: readonly WorkerConfig[],
    private readonly healthFn: HealthFn = checkHealth,
  ) {
```
The loop gets `provider: InferenceProvider` the same way; tests pass a plain object.

### ERROR_HANDLING
// SOURCE: src/ollama.ts:57-77
Abort passes through untouched; connection failures are rewrapped with a one-line remedy; non-2xx → `Error("<provider> error: <status> <text>")`.
```ts
  } catch (err) {
    // An abort is the caller's doing (cancel/timeout) — pass its reason through untouched
    if (signal?.aborted) throw err;
```

### NAMING_CONVENTION
// SOURCE: src/worktree.ts:1-3, src/pool.ts:1-2
File header comment says what the module does and what it deliberately does not.

### CONFIG_PATTERN
// SOURCE: src/config.ts:62-84 (`parseWorkers`)
Validation throws `ConfigError("AGENT_WORKERS", raw, expected)`; hosts have trailing slashes stripped.

### TEST_STRUCTURE (HTTP)
// SOURCE: src/__tests__/ollama.test.ts:12-24
```ts
async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
```

---

## Files to Change

| File | Action | Responsibility |
|---|---|---|
| `src/provider.ts` | CREATE | `InferenceProvider` interface, `ChatRequest`/`ChatResponse`, `OpenAIProvider`, `createProvider(worker)` |
| `src/__tests__/provider.test.ts` | CREATE | OpenAI translation both ways against a mock server; `createProvider` selection |
| `src/ollama.ts` | UPDATE | Wrap `chatWithOllama`/`checkHealth` in `OllamaProvider`; add `id?`/`tool_call_id?` to the message types |
| `src/loop.ts` | UPDATE | Take `provider` instead of `host`; set `tool_call_id` on tool results |
| `src/pool.ts` | UPDATE | `HealthFn(worker)`; default probes via `createProvider(worker).health()`; snapshot gains `provider` |
| `src/config.ts` | UPDATE | `WorkerConfig.provider`, inferred from `/v1`; `AGENT_API_KEY` |
| `src/index.ts` | UPDATE | Build provider in `runJob`; startup line shows providers; num_ctx note |
| `src/__tests__/{loop,pool,config,ollama,server.e2e}.test.ts` | UPDATE | Fake provider instead of `vi.mock`; provider selection; OpenAI-shaped mock in e2e |
| `README.md` | UPDATE | Providers section; `AGENT_API_KEY` |

## NOT Building

- **Streaming.** The reason it was queued (fetch's 300 s headers timeout on long generations) has not bitten: at ~88 tok/s a single turn would need >26k output tokens. Add when a real timeout shows up.
- A `provider:` prefix syntax in `AGENT_WORKERS`. The `/v1` suffix is unambiguous for every server in scope; a YAML config (§24) can add the field later.
- Per-provider model listing / `modelInfo()` (§6 optional).
- Token accounting in results (Phase 6). `ChatResponse` carries `usage` when the backend reports it so Phase 6 does not need to touch the providers again — that is the whole concession.
- Anthropic/Gemini-style providers, API-key rotation, retries on 5xx.
- Renaming `Ollama*` types. They are the internal chat format now; `provider.ts` re-exports them under neutral aliases (`ChatMessage`, `ToolCall`, `ToolDefinition`) and new code uses the aliases. A repo-wide rename is churn without behaviour.

---

## Step-by-Step Tasks

### Task 0: Branch and baseline
- **ACTION**: `git checkout -b feat/provider-abstraction` from `main`; `npm test`.
- **VALIDATE**: 255 pass.

### Task 1: Config — provider per worker (test first)
- **ACTION**: `src/__tests__/config.test.ts`, then `src/config.ts`.
- **IMPLEMENT**: `WorkerConfig` gains `provider: "ollama" | "openai"`. In `parseWorkers` and the `OLLAMA_HOST` fallback: `provider: /\/v1$/.test(host) ? "openai" : "ollama"` (after trailing-slash strip). New optional `apiKey?: string` on `AppConfig` from `AGENT_API_KEY` (CONF-11; no validation). Tests: `gpu0=http://a:11434` → ollama; `gpu1=http://a:8001/v1/` → openai with host `http://a:8001/v1`; `OLLAMA_HOST=http://a:11434/v1` → single worker, openai; every existing `toEqual` on workers gains `provider: "ollama"`; `AGENT_API_KEY` set → `apiKey`; add to `ENV_KEYS`.
- **GOTCHA**: Strip the trailing slash *before* testing for `/v1`.
- **VALIDATE**: config tests green; `npm run typecheck` will now fail elsewhere — expected until Task 6.

### Task 2: Provider interface + Ollama provider
- **ACTION**: Create `src/provider.ts` (interface + factory skeleton); update `src/ollama.ts`.
- **IMPLEMENT** (`provider.ts`):
  ```ts
  // Inference providers — the agent loop talks to this interface only.
  // The internal chat format is the Ollama shape (object tool arguments);
  // each provider translates to its wire format.

  import type { OllamaMessage, OllamaToolCall, OllamaToolDefinition } from "./ollama.js";
  import type { WorkerConfig } from "./config.js";

  export type ChatMessage = OllamaMessage;
  export type ToolCall = OllamaToolCall;
  export type ToolDefinition = OllamaToolDefinition;

  export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    jsonOnly?: boolean;   // parser correction turns
    numCtx?: number;      // Ollama only
  }

  export interface ChatResponse {
    message: ChatMessage;
    usage?: { promptTokens: number; completionTokens: number };
  }

  export interface InferenceProvider {
    readonly kind: "ollama" | "openai";
    chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
    health(): Promise<boolean>;
  }
  ```
  `ollama.ts`: add `id?: string` to `OllamaToolCall` and `tool_call_id?: string` to `OllamaMessage`. Add
  ```ts
  export class OllamaProvider implements InferenceProvider {
    readonly kind = "ollama" as const;
    constructor(private readonly host: string) {}
    async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
      const response = await chatWithOllama(this.host, {
        model: request.model, messages: request.messages, tools: request.tools, stream: false,
        ...(request.jsonOnly && { format: "json" }),
        ...(request.numCtx && { options: { num_ctx: request.numCtx } }),
      }, signal);
      return {
        message: response.message,
        ...(response.prompt_eval_count !== undefined && {
          usage: { promptTokens: response.prompt_eval_count, completionTokens: response.eval_count ?? 0 },
        }),
      };
    }
    health(): Promise<boolean> { return checkHealth(this.host); }
  }
  ```
  `OllamaChatResponse` gains `prompt_eval_count?: number; eval_count?: number`. Keep `chatWithOllama`/`checkHealth` exported (tests use them).
- **GOTCHA**: `provider.ts` imports types from `ollama.ts` and `ollama.ts` imports types from `provider.ts` — type-only cycles are fine in TS (`import type`).
- **VALIDATE**: `npx tsc --noEmit` errors only in loop/pool/index (still on the old API).

### Task 3: OpenAI provider (test first)
- **ACTION**: Create `src/__tests__/provider.test.ts`; implement `OpenAIProvider` in `src/provider.ts`.
- **IMPLEMENT**: tests with the `listen()` helper (copy from `ollama.test.ts`) capturing the request body:
  1. **Outbound translation**: history `[system, user, assistant{content:"", tool_calls:[{id:"call_1", function:{name:"read_file", arguments:{path:"a"}}}]}, tool{tool_call_id:"call_1", tool_name:"read_file", content:"x"}]` → body has `messages[2].tool_calls[0]` = `{id:"call_1", type:"function", function:{name:"read_file", arguments:'{"path":"a"}'}}`, `messages[3]` = `{role:"tool", tool_call_id:"call_1", content:"x"}` (no `tool_name`), `tools` passed through, `stream:false`, no `options`/`format`; `jsonOnly` → `response_format:{type:"json_object"}`; `numCtx` ignored.
  2. **Missing id**: assistant tool call without `id` (text-extracted) → outbound gets `id:"call_0"` and the following tool message `tool_call_id:"call_0"`.
  3. **Inbound translation**: server replies `{choices:[{message:{role:"assistant", content:null, reasoning:"…", tool_calls:[{id:"call_9", type:"function", function:{name:"bash", arguments:'{"command":"ls"}'}}]}, finish_reason:"tool_calls"}], usage:{prompt_tokens:10, completion_tokens:5}}` → `message.content === ""`, `tool_calls[0]` = `{id:"call_9", function:{name:"bash", arguments:{command:"ls"}}}`, `usage` = `{promptTokens:10, completionTokens:5}`.
  4. **Malformed arguments string** (`"{not json"`) → `arguments: {}` and the raw string preserved under `_raw`? No — keep simple: `arguments: {}` and `console.error` once; the loop's tool call then fails with a clear tool error and the model retries. Test asserts `{}`.
  5. **Auth header**: constructed with `apiKey: "k"` → `Authorization: Bearer k` present; without → absent.
  6. **Health**: `/models` 200 → true; refused → false; 401 → false.
  7. **Errors**: 500 → rejects `/OpenAI-compatible server error: 500/`; refused → `/no OpenAI-compatible server at/`; aborted signal → rejects with the abort reason (`TimeoutError`).
  8. **`createProvider`**: `{provider:"ollama"}` → `kind === "ollama"`; `{provider:"openai"}` → `"openai"`.

  Implementation sketch:
  ```ts
  export class OpenAIProvider implements InferenceProvider {
    readonly kind = "openai" as const;
    constructor(private readonly base: string, private readonly apiKey?: string) {}

    async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
      const body = {
        model: request.model,
        messages: toOpenAIMessages(request.messages),
        tools: request.tools,
        stream: false,
        ...(request.jsonOnly && { response_format: { type: "json_object" } }),
      };
      const resp = await this.fetch("/chat/completions", { method: "POST", body: JSON.stringify(body) }, signal);
      const data = (await resp.json()) as OpenAIChatCompletion;
      const choice = data.choices?.[0]?.message;
      if (!choice) throw new Error("OpenAI-compatible server returned no choices");
      return { message: fromOpenAIMessage(choice), ...(data.usage && { usage: {...} }) };
    }
    async health(): Promise<boolean> { try { return (await this.fetch("/models", {}, AbortSignal.timeout(3000))).ok; } catch { return false; } }
  }
  ```
  `toOpenAIMessages` assigns `call_${i}` ids to assistant tool calls lacking one and rewrites the *next* tool messages' `tool_call_id` in order (one tool message per call, in call order — that is how the loop emits them). Drop `tool_name`.
  `fromOpenAIMessage`: `content ?? ""`, parse each `function.arguments` with try/catch.
  `createProvider(worker: WorkerConfig, apiKey?: string): InferenceProvider` → `worker.provider === "openai" ? new OpenAIProvider(worker.host, apiKey) : new OllamaProvider(worker.host)`.
- **MIRROR**: ERROR_HANDLING (abort passthrough first, then connection rewrap, then status check).
- **GOTCHA**: Type `arguments` in the outbound message as `string`, not the internal object — define separate `OpenAIMessage` types in `provider.ts`, do not reuse `OllamaMessage` for the wire. `tools: []` — some servers reject an empty tools array; send `tools` only when non-empty.
- **VALIDATE**: `npx vitest run src/__tests__/provider.test.ts` green.

### Task 4: Loop takes a provider (test first)
- **ACTION**: `src/__tests__/loop.test.ts`, then `src/loop.ts`.
- **IMPLEMENT**: Replace `vi.mock("../ollama.js")` with a fake provider: `const chat = vi.fn(); const provider = { kind: "ollama" as const, chat, health: async () => true };` and `run()` passes `provider` instead of `host`. `reply()` builds `{ message }`. Assertions on `chat.mock.calls[n][1]` become `[n][0]` for the request and `[n][1]` for the signal; `format: "json"` → `jsonOnly: true`; `options.num_ctx` → `numCtx`. New test: a native tool call with `id:"call_7"` → the pushed tool message has `tool_call_id:"call_7"`; without id → no `tool_call_id`. Loop: option `provider: InferenceProvider` (drop `host`); both call sites → `provider.chat({ model, messages, tools, jsonOnly?, numCtx }, signal)`; tool result push adds `...(tc.id && { tool_call_id: tc.id })`.
- **GOTCHA**: `chatFn` (parser retries) passes `jsonOnly: true`; the main call must not.
- **VALIDATE**: loop tests green.

### Task 5: Pool health via provider (test first)
- **ACTION**: `src/__tests__/pool.test.ts`, then `src/pool.ts`.
- **IMPLEMENT**: `HealthFn = (worker: WorkerConfig) => Promise<boolean>`; default `(w) => createProvider(w).health()`; existing tests' `healthFn` lambdas take `w` and compare `w.host`; `W` entries gain `provider: "ollama"`. `WorkerSnapshot` gains `provider`; status test expects it.
- **GOTCHA**: `createProvider` needs the api key for OpenAI health — constructor option: `new WorkerPool(configs, healthFn?)` stays; `index.ts` passes `(w) => createProvider(w, config.apiKey).health()` explicitly.
- **VALIDATE**: pool tests green.

### Task 6: Wire `index.ts`
- **ACTION**: `runJob` builds `const provider = createProvider(w, config.apiKey)` and passes it to `runAgentLoop` (remove `host`). Pool constructed with the explicit health fn. Startup line: `workers: gpu0=http://…(ollama), gpu1=http://…/v1(openai)`; if `config.numCtx` is set and any worker is openai, log once `[config] AGENT_NUM_CTX is ignored for OpenAI-compatible workers (set context on the server)`.
- **VALIDATE**: `npm run typecheck && npm run lint && npm run build`; `ollama.test.ts` still green (add a test that `new OllamaProvider(url).chat(...)` maps `prompt_eval_count`/`eval_count` to `usage`).

### Task 7: E2E with an OpenAI-shaped worker
- **ACTION**: Extend `src/__tests__/server.e2e.test.ts`.
- **IMPLEMENT**: `startMockOllama` gains a `shape: "ollama" | "openai"` parameter. OpenAI shape: `GET /v1/models` → `{data:[]}`; `POST /v1/chat/completions` → `{choices:[{message:{role:"assistant", content: call ? null : "done", tool_calls: call && [{id:"call_1", type:"function", function:{name, arguments: JSON.stringify(args)}}]}}], usage:{prompt_tokens:1, completion_tokens:1}}`; record whether an inbound tool message carried `tool_call_id === "call_1"`. Spawn with `gpu1=${gpu1.url}/v1` (gpu0 stays Ollama-shaped). Tests: `local_worker_status` shows `provider: "ollama"` / `"openai"`; `run_local_agent({prompt:"write: x", mode:"implement", worker:"gpu1"})` → diff returned and the mock saw `tool_call_id: "call_1"` on the tool message; the existing parallel test still passes (both shapes).
- **GOTCHA**: The openai mock must route on `req.url` (`/v1/models`, `/v1/chat/completions`) — the base already contains `/v1`. The `prompts` capture reads `messages[1].content` — same for both shapes.
- **VALIDATE**: e2e green 3×.

### Task 8: Docs
- **ACTION**: `README.md`.
- **IMPLEMENT**: "Providers" subsection under Multiple workers: URL rule (`/v1` → OpenAI-compatible), tested servers list (Ollama `/v1` verified; vLLM / llama.cpp / LM Studio expected — say which were actually run), `AGENT_API_KEY` row in the config table, note that `AGENT_NUM_CTX` applies to Ollama workers only, example `AGENT_WORKERS` mixing both. Troubleshooting: "no OpenAI-compatible server at …".
- **VALIDATE**: `grep -rn "192\.168" README.md CLAUDE.md src .claude/PRPs` empty.

### Task 9: Full validation + live check
- **ACTION**: Validation Commands, then Manual Validation.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| provider inferred | `…/v1/` | openai, slash stripped | |
| outbound tool call | object args | JSON string + `type:"function"` | core |
| outbound tool result | `tool_call_id` | echoed; `tool_name` dropped | core |
| missing call id | text-extracted call | `call_0` assigned on both sides | yes |
| inbound null content | `content:null` | `""` | yes |
| inbound bad arguments | `"{not json"` | `{}` | yes |
| auth header | `apiKey` | Bearer present/absent | |
| health | 200 / 401 / refused | true / false / false | yes |
| errors | 500 / refused / abort | typed messages / abort reason | yes |
| loop tool_call_id | native call with id | pushed on tool message | core |
| pool snapshot | — | `provider` field | |
| e2e mixed pool | ollama + openai mocks | both work; `tool_call_id` round-trips | core |

### Edge Cases Checklist
- [x] Empty input — `tools: []` not sent; `choices: []` → clear error
- [x] Invalid types — malformed arguments string
- [x] Network failure — refused, 500, 401, abort
- [ ] Concurrent access — unchanged from Phase 2
- [x] Auth — optional bearer

---

## Validation Commands

### Static Analysis
```bash
npm run typecheck && npm run lint
```

### Unit Tests
```bash
npx vitest run src/__tests__/provider.test.ts src/__tests__/loop.test.ts src/__tests__/pool.test.ts src/__tests__/config.test.ts src/__tests__/ollama.test.ts
```

### Full Test Suite
```bash
npm test && npm run build
```
EXPECT: 255 baseline + new pass; e2e 3× green

### Manual Validation
Live endpoint in project memory (`ollama-gpu-host`). Ollama serves both shapes, so the same box exercises both providers:
- [ ] `AGENT_WORKERS=native=<host>:11434,compat=<host>:11434/v1` → `local_worker_status` shows `ollama` and `openai`, both `idle`.
- [ ] `local_analyze(..., worker:"compat")` — the read-only listing task from Phase 1 — completes with native tool calls through `/v1`; header shows the job; stderr shows no parse fallbacks.
- [ ] `local_implement(..., worker:"compat")` — the `AGENT_TIMEOUT_SECONDS` default change — returns a diff; `tool_call_id` round-trip works over several iterations.
- [ ] Same two jobs on `worker:"native"` still behave as in Phase 4.
- [ ] `local_cancel` on a `compat` job → `status cancelled`.
- [ ] Optional, if vLLM or llama.cpp is available on the box: repeat the analyze job against it and note it in the README's tested list; otherwise the README says only Ollama `/v1` was verified.

---

## Acceptance Criteria
(goal doc §27)
- [ ] Local inference provider is not permanently tied to Ollama
- [ ] Two providers: Ollama and OpenAI-compatible, selected per worker
- [ ] Existing single-worker `run_local_agent` usage remains compatible (no config change needed)
- [ ] typecheck, lint, test, build pass

## Completion Checklist
- [ ] `loop.ts`, `pool.ts`, `parser.ts`, `tools.ts` import nothing provider-specific except the shared types
- [ ] Abort reason passes through both providers untouched
- [ ] No real hostnames/IPs in committed files
- [ ] README updated with what was actually tested

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A server rejects `tools` for models without tool support, or needs `tool_choice` | Medium | Medium | Error surfaces as `OpenAI-compatible server error: 400 …` with the body's first 200 chars; text-extraction fallback still works if `tools` is omitted — expose `AGENT_NO_TOOLS`? No: wait for a real case |
| `reasoning`/`reasoning_content` fields inflate history when echoed back | Low | Low | Provider drops unknown fields on the way out (only role/content/tool_calls/tool_call_id are sent) |
| Text-extracted calls get synthetic ids that collide across turns | Low | Low | Ids are per-request counters; servers only need uniqueness within one request's history — verify on the live `/v1` run |
| llama.cpp/vLLM differences (e.g. `arguments` already an object) | Medium | Low | `fromOpenAIMessage` accepts both string and object |
| `/v1` heuristic misfires for an Ollama base that happens to end in `/v1` | Low | Low | That *is* Ollama's OpenAI endpoint — correct either way |

## Notes
- Verified live before planning: Ollama 0.34.2's `/v1/chat/completions` returns `content: ""`, `reasoning`, `tool_calls[].function.arguments` as a JSON string with `id` and `type`, `finish_reason: "tool_calls"`, and `usage` — so the OpenAI provider has a real target on the existing box.
- `usage` on `ChatResponse` is the one forward-looking field, added so Phase 6 (metrics) does not have to reopen both providers.
- Streaming stays out (see NOT Building) with the reasoning recorded; if a job ever fails with "did not respond in time", that is the trigger.
