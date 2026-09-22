# Implementation Report: Provider Abstraction (Goal Doc Phase 5)

## Summary
The agent loop and the pool now talk to an `InferenceProvider` (`chat(request, signal)`, `health()`) instead of the Ollama client directly. Two implementations: `OllamaProvider` (the existing client, wrapped) and `OpenAIProvider` (vLLM, llama.cpp server, LM Studio, Ollama `/v1`) which translates tool calls both ways (object arguments ⇄ JSON string, `tool_call_id` on tool results, `content: null` → `""`). The provider is chosen per worker from its URL: a base ending in `/v1` is OpenAI-compatible, anything else is Ollama. Optional `AGENT_API_KEY` is sent as a bearer token. `local_worker_status` shows each worker's `provider`.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Single pass, no surprises |
| Files Changed | 11 (2 new) | 12 (2 new) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 0 | Branch + baseline | Complete | 255 tests |
| 1 | `WorkerConfig.provider` from URL; `AGENT_API_KEY` | Complete | `workerFor()` helper shared by `AGENT_WORKERS` and `OLLAMA_HOST` paths |
| 2 | Interface + `OllamaProvider` | Complete | `usage` mapped from `prompt_eval_count`/`eval_count` |
| 3 | `OpenAIProvider` + tests | Complete | 11 tests against a capturing mock server |
| 4 | Loop takes a provider | Complete | Loop tests use a plain fake object; no more `vi.mock` |
| 5 | Pool health via provider | Complete | `HealthFn(worker)`; snapshot gains `provider` |
| 6 | Wire `index.ts` | Complete | One-line startup note when `AGENT_NUM_CTX` is set alongside an OpenAI worker |
| 7 | E2E with a mixed pool | Complete | gpu0 Ollama-shaped, gpu1 OpenAI-shaped; `tool_call_id` round-trip asserted |
| 8 | Docs | Complete | README "Providers", `AGENT_API_KEY`, troubleshooting |
| 9 | Validation + live | Complete | Below |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | |
| Unit Tests | Pass | 272 (255 baseline + 17 new) |
| Build | Pass | |
| Integration | Pass | e2e 14 tests, 3× green: mixed pool, status shows both providers, implement through the OpenAI-shaped worker returns a diff and the mock saw `tool_call_id: "call_0"` |
| Edge Cases | Pass | empty `tools` omitted; `content: null`; unparseable / object-form arguments; 401 / 500 / refused / abort; response without `choices`; missing call ids get `call_<n>` |

## Live Validation (2026-09-21, one Ollama 0.34.2 host serving both shapes, `qwen3.8:27b`)

`AGENT_WORKERS=native=<host>:11434,compat=<host>:11434/v1`

| Check | Result |
|---|---|
| `local_worker_status` | `native` → `provider: "ollama"`, `compat` → `provider: "openai"` |
| `local_analyze` on `compat` | native tool call arrived through `/v1`; 2 iterations, 20 s, `status completed`, findings with line numbers |
| `local_implement` on `compat` (two-file edit + vitest) | 4 iterations incl. two parallel tool calls per turn (so multiple `tool_call_id`s per request), 14 s, diff returned, checkout untouched, worktree removed |
| `local_analyze` on `native` | unchanged behaviour: 3 iterations, 22 s, `status completed` |

Not run: vLLM, llama.cpp, LM Studio — none is installed on the box. The README says so.

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/provider.ts` | CREATED | +201 |
| `src/__tests__/provider.test.ts` | CREATED | +264 |
| `src/__tests__/server.e2e.test.ts` | UPDATED | +67 / -10 |
| `src/ollama.ts` | UPDATED | +48 / -3 |
| `src/__tests__/ollama.test.ts` | UPDATED | +40 / -1 |
| `src/__tests__/config.test.ts` | UPDATED | +29 / -4 |
| `src/config.ts` | UPDATED | +21 / -4 |
| `README.md` | UPDATED | +29 / -2 |
| `src/__tests__/loop.test.ts` | UPDATED | +29 / -13 |
| `src/loop.ts` | UPDATED | +7 / -25 |
| `src/index.ts` | UPDATED | +10 / -3 |
| `src/pool.ts` | UPDATED | +9 / -5 |
| `src/__tests__/pool.test.ts` | UPDATED | +4 / -4 |

## Deviations from Plan
1. `ChatResponse.usage` is captured by both providers (as planned) but not surfaced anywhere yet — Phase 6.
2. `fromOpenAIMessage` also accepts an already-parsed object for `arguments` (some servers send that); the plan listed it as a risk, the code handles it.

## Issues Encountered
None.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `provider.test.ts` | 11 | outbound/inbound translation, invented ids, empty tools, response_format, bearer, 500/refused/abort, no choices, health 200/401/refused, factory |
| `config.test.ts` | +3 | `/v1` inference, `OLLAMA_HOST` with `/v1`, `AGENT_API_KEY` |
| `ollama.test.ts` | +1 | `OllamaProvider` request mapping and usage |
| `loop.test.ts` | +1 | `tool_call_id` echoed on tool results |
| `server.e2e.test.ts` | +1 | implement through the OpenAI-shaped worker |

## Code Review Follow-up (2026-09-21, `/code-review` medium, 1 finding, addressed)

| # | Finding | Fix |
|---|---|---|
| 1 | High — text-extracted tool calls were never attached to the assistant message in history, so on an OpenAI-compatible worker the next turn sent tool results with no preceding `tool_calls` (a 400 on strict servers); the invented-id path in `toOpenAIMessages` was unreachable | `assistantMessage.tool_calls = toolCalls` once extraction resolves; test asserts the history and its OpenAI translation are consistent. Ollama history is now consistent too |

273 tests total.

## Not Verified
- Any server other than Ollama behind the OpenAI-compatible provider.
- Behaviour when a server rejects `tools` for a model without tool support (error text is designed to make that obvious).

## Next Steps
- [ ] `/code-review`, then `/prp-commit`
- [ ] Phase 6: job records, token/timing metrics (`usage` is ready), worker utilisation
