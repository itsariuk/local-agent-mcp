# Implementation Report: Qwen-Ready Single Worker (Goal Doc Phase 1)

## Summary
The agent loop now ends on a prose answer instead of forcing three JSON correction retries and failing. The main chat call no longer sends `format: "json"`; tool results carry `tool_name`; `AGENT_NUM_CTX` reaches Ollama as `options.num_ctx`. Added a `replace_text` edit tool, raised defaults to 20 iterations / 120 s, replaced the system prompt, clipped tool output sent to the model (16 000 chars) and failure output returned to the supervisor (500 chars). `run_local_agent`'s input schema is unchanged.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Single pass; one test of mine was wrong, one lint rule not anticipated |
| Files Changed | 12 (1 new) | 12 (1 new) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 0 | Install deps, baseline | Complete | 83 tests passing before changes |
| 1-2 | `replace_text` tests + implementation | Complete | Red phase not run separately; tests and code landed together |
| 3 | Parser signature + exports | Complete | Deviated — see below |
| 4 | Config defaults + `AGENT_NUM_CTX` | Complete | |
| 5 | Ollama types | Complete | |
| 6 | Loop tests | Complete | |
| 7 | Termination fix, drop main-call `format` | Complete | |
| 8 | `tool_name`, `num_ctx`, model-facing clip | Complete | |
| 9 | System prompt | Complete | |
| 10 | `formatAgentResult` | Complete | |
| 11 | Wire `index.ts` | Complete | |
| 12 | Fetch failure message | Complete | Deviated — see below |
| 13 | README + CLAUDE.md | Complete | |
| 14 | Full validation | Complete | Automated checks pass; live checks run against `qwen3.8:27b` — see Live Validation |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | `tsc --noEmit` and `eslint src/` clean |
| Unit Tests | Pass | 114 passing (83 baseline + 31 new) |
| Build | Pass | `build/index.js` emitted |
| Integration | Pass | Live runs against `qwen3.8:27b` (see Live Validation). Built server also smoke-tested over stdio: initialize, tools/list (schema unchanged), tools/call with Ollama down returns `isError: true` with the expected message; startup line shows `ctx: 32768`. |
| Edge Cases | Pass | empty/ambiguous/missing `old_text`, `$&` in `new_text`, path traversal, 50 000-char output clip, empty final message, parse-failure clip |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/__tests__/loop.test.ts` | CREATED | +177 |
| `src/loop.ts` | UPDATED | +110 / -27 |
| `src/tools.ts` | UPDATED | +55 / -1 |
| `src/index.ts` | UPDATED | +5 / -41 |
| `src/ollama.ts` | UPDATED | +12 / -1 |
| `src/config.ts` | UPDATED | +11 / -3 |
| `src/parser.ts` | UPDATED | +8 / -2 |
| `src/__tests__/tools.test.ts` | UPDATED | +45 / -2 |
| `src/__tests__/config.test.ts` | UPDATED | +18 / -2 |
| `src/__tests__/parser.test.ts` | UPDATED | +8 / -0 |
| `README.md` | UPDATED | +24 / -4 |
| `CLAUDE.md` | UPDATED | +1 / -0 |

## Deviations from Plan
1. **Parser test input (Task 3).** The plan's test used bare `{"path","old_text","new_text"}`. The parser only infers a tool name when arguments sit under a `parameters`-style key (`parser.ts` `normalizeToolCall`), so the test was wrong, not the parser. Changed the input to `{"parameters": {...}}`, matching the existing `write_file` inference test. Consequence worth knowing: a model that emits bare arguments with no name and no wrapper is still not recognised — unchanged from before.
2. **`isKnownTool` uses `Object.hasOwn`** rather than `in`, so `"toString"` and friends are not treated as known tools.
3. **`{ cause: err }` on both fetch errors (Task 12).** ESLint's `preserve-caught-error` rule required it. Harmless and useful for debugging.
4. **`numCtx` spread** is built as `{ options: { num_ctx } } | {}` rather than the plan's `&&` form — same behaviour, cleaner types.

## Issues Encountered
- `npm install` blocked esbuild's postinstall script (npm `allowScripts` policy). vitest and tsx still ran fine here; if `npm run dev` misbehaves, run `npm install-scripts approve esbuild`.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `src/__tests__/loop.test.ts` | 10 | termination, embedded tool call, correction retry, no main-call `format`, `tool_name`, `num_ctx`, model clip, report formatting |
| `src/__tests__/tools.test.ts` | +6 | `replace_text` |
| `src/__tests__/config.test.ts` | +2 | `AGENT_NUM_CTX` |
| `src/__tests__/parser.test.ts` | +1 | `replace_text` signature ordering |

## Live Validation (added 2026-09-21, Ollama 0.34.2 on a LAN host, `qwen3.8:27b` Q4_K_M, `AGENT_NUM_CTX=32768`)

Run through the built server (`build/index.js`) over MCP stdio, working in a scratch copy of the repo.

| Check | Result |
|---|---|
| Raw `/api/chat` with tools | Native `tool_calls`, arguments as an object, each call has an `id`; message also carries a `thinking` field. ~88 tok/s generation, 15.6 s cold model load. |
| Read-only task (list exports of `src/security.ts`) | 1 iteration, correct answer, prose ended the job, no parse failure, 6.1 s |
| `replace_text` edit (change a default in `src/config.ts`) | 3 iterations (read, replace, re-read), one-line `git diff`, 8.8 s |
| Run tests → diagnose → fix → re-run | 3 iterations incl. 3 parallel tool calls in one turn; one-line fix to the test, left `src/config.ts` alone as told; its "102 passed" claim confirmed by running vitest independently; 17.8 s |
| Run-and-report only | Correct counts and failing test name, no files touched, 9.6 s |
| Ollama down | `isError: true`, "Ollama is not running at ..." |

Text-extraction and correction-retry paths never triggered with this model — every tool call arrived natively. They remain covered by unit tests only.

### Found during live runs
- **ANSI colour codes in shell output** (vitest's `[32m- Expected[39m`) reached both the model and the supervisor report. Fixed in `src/tools.ts` by stripping them from bash output; one test added (103 total). Confirmed gone on a re-run.

## Code Review Follow-up (2026-09-21, `/code-review` medium, 5 findings, all addressed)

| # | Finding | Fix |
|---|---|---|
| 1 | Final answer opening with a code fence / JSON was sent to the correction retry, which could pressure the model into inventing a tool call | Replaced the start-of-message regex with `classifyText` in `src/parser.ts`: retry only when the text names a known tool (quoted) or uses `<tool_call>` and nothing parsed |
| 2 | Truncated tool call after a prose preamble was reported as a successful final answer | Same classifier — a broken attempt is detected anywhere in the message |
| 3 | A tool call quoted inside the final report was executed again | A parsed call counts only when the JSON sits at the start or end of the message. Reproduced live with `qwen3.8:27b` (asked it to quote its call): job ended correctly in 2 iterations |
| 4 | `replace_text` with `new_text` missing silently deleted the match | Missing `new_text` is rejected; an explicit empty string still deletes |
| 5 | `UND_ERR_BODY_TIMEOUT` branch unreachable (body is read outside the try) | Removed the dead half of the condition |

`extractToolCalls` is private again and `isKnownTool` is gone — `classifyText` is the only new parser export. 11 tests added (114 total).

Residual: a message that names a tool in quotes, has no parseable JSON, and is actually a final answer would still trigger the correction retry. Not seen in any live run.

## Still Not Verified
- The undici timeout codes in `ollama.ts` (`UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`) are from memory; no generation came close to the limit. A wrong code only means the old "not running" message is shown.
- Long tasks that fill the 32k context, and behaviour at the iteration limit with a real model.
- `thinking` is passed back to Ollama in the history untouched (the TS type does not declare it). It worked in every run; whether it should be dropped to save context is an open question for Phase 6 metrics.

## Next Steps
- [ ] Code review via `/code-review`
- [ ] Commit via `/prp-commit`, PR via `/prp-pr`
- [ ] `/prp-plan` for goal doc Phase 2 (worker pool)
