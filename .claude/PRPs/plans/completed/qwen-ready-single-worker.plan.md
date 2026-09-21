# Plan: Qwen-Ready Single Worker (Goal Doc Phase 1)

## Summary
Make the existing single-worker agent loop actually usable with a Qwen3.8-27B-class model on Ollama: fix the loop so a prose final answer terminates the job, stop forcing `format: "json"` on native-tool-calling models, add a `replace_text` edit tool, make context size configurable, raise defaults, tighten the system prompt, and cap what is returned to the supervisor. No worker pool, no worktrees, no new MCP tools — those are Phases 2–4.

## User Story
As a Claude Code / Codex supervisor,
I want `run_local_agent` to complete bounded tasks with a 27B Qwen model and return a compact, honest report,
So that delegating is cheaper than doing the work myself.

## Problem → Solution
Today the loop cannot finish cleanly (see "Core defect" below), sends `format: "json"` on every turn, has only whole-file `write_file` for edits, runs on Ollama's default context, stops at 10 iterations / 30 s commands, and can return up to 1 MB of failure output to the supervisor.
→ A loop that terminates on a prose answer, native tool calling first with text-extraction fallback, a deterministic edit tool, `AGENT_NUM_CTX`, 20 iterations / 120 s defaults, a §19-style system prompt, and a clipped result.

### Core defect (verified by reading, not by running)
`src/loop.ts:99-128`: when the model returns no native `tool_calls`, the content goes to `parseToolCall`. `parseToolCall` (`src/parser.ts:366-402`) returns either `OllamaToolCall[]` or a `ParseFailure` — **never `null` or `[]`**. So the "model is done" branch at `loop.ts:125` is unreachable for any non-empty prose answer: a final summary triggers 3 correction retries that demand a JSON tool call, then either another tool call runs or the job ends as `parseFailure` with `finalMessage: ""`. The only ways a job ends today are parse failure or the iteration limit.

## Metadata
- **Complexity**: Medium
- **Source PRD**: `local-agent-mcp-dual-3090-orchestration-goal.md`
- **PRD Phase**: §28 "Phase 1 — Make upstream usable with Qwen3.8" (the doc has no status markers; Phase 1 is the first and has no dependencies)
- **Estimated Files**: 11 (1 created, 10 updated)

---

## UX Design

### Before
```
supervisor -> run_local_agent("fix lint in src/x.ts")
  model: read_file -> write_file(whole file) -> "Done, fixed 3 errors."
  loop:  prose is not a tool call -> 3 correction retries -> ParseFailure
supervisor <- "read_file(...) → 120 lines
               write_file(...) → wrote 4100 bytes
               [parse failed after 3 attempts: No JSON object found in response]"
```

### After
```
supervisor -> run_local_agent("fix lint in src/x.ts")
  model: read_file -> replace_text x3 -> bash(npm run lint) -> "Done, fixed 3 errors."
  loop:  prose + no tool call -> final message, stop
supervisor <- "read_file(...) → 120 lines
               replace_text(...) → replaced 1 occurrence in src/x.ts
               bash(command="npm run lint") → ok
               Done, fixed 3 errors. Lint passes."
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| Job end | parse failure or iteration limit | prose answer ends the job | core fix |
| Edits | `write_file` whole file | `replace_text` exact unique match | `write_file` kept |
| Context size | Ollama default | `AGENT_NUM_CTX` → `options.num_ctx` | unset = unchanged behaviour |
| Defaults | 10 iterations, 30 s | 20 iterations, 120 s | matches goal doc §24 |
| Failure output to supervisor | up to 1 MB | clipped to 500 chars per step | §13 |
| Tool output to model | up to 1 MB | clipped to 16 000 chars | protects 27B context |
| `run_local_agent` input schema | `prompt`, `model?` | unchanged | backward compatible |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/loop.ts` | 33-167 | The loop being fixed; message-order invariants LOOP-03/LOOP-04 |
| P0 | `src/parser.ts` | 46-52, 272-314, 366-402 | `TOOL_SIGNATURES` order matters; `extractToolCalls`; retry contract |
| P0 | `src/tools.ts` | 20-97, 112-133, 238-271 | Tool definition + executor + dispatch pattern to mirror |
| P1 | `src/index.ts` | 42-108 | Result formatting that moves into `loop.ts` |
| P1 | `src/config.ts` | 42-102 | `parsePositiveInt`, CONF-nn comment style |
| P1 | `src/ollama.ts` | 3-66 | Request/response types, error style |
| P2 | `src/__tests__/tools.test.ts` | 1-52 | Temp-dir test setup, `executeTool` call shape |
| P2 | `src/__tests__/config.test.ts` | 9-66 | `ENV_KEYS` snapshot pattern, default assertions to update |
| P2 | `src/__tests__/parser.test.ts` | 12-25 | `mockChatFn` / `noopChatFn` helpers |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Ollama `/api/chat` | https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md (fetched 2026-09-21) | `tool_calls[].function.arguments` is an object; tool results are `{role:"tool", content, tool_name}`; `options` carries model params such as `num_ctx`; `format` is `"json"` or a schema; `think` is boolean or a level; final response has `prompt_eval_count` / `eval_count` |

```
KEY_INSIGHT: Tool result messages take a `tool_name` field; the current loop omits it.
APPLIES_TO: Task 8
GOTCHA: Optional field — harmless for older Ollama, helps templates that render the tool name.

KEY_INSIGHT: `format: "json"` constrains every turn to JSON, including the final answer and any native tool-call turn.
APPLIES_TO: Task 7
GOTCHA: Keep `format: "json"` on the parser's correction chatFn only — that call really does want bare JSON.

KEY_INSIGHT: Context length is set per request through `options.num_ctx`; the docs do not state the default.
APPLIES_TO: Tasks 3-4
GOTCHA: Do not invent a default. Unset `AGENT_NUM_CTX` must send no `options` at all.

KEY_INSIGHT (from memory, NOT verified): Node's built-in fetch has a ~300 s headers timeout; with `stream:false` a long 27B generation can exceed it and currently surfaces as "Ollama is not running".
APPLIES_TO: Task 9
GOTCHA: Only the error message is fixed here. Streaming is the real fix and belongs with the Phase 5 provider work.
```

---

## Patterns to Mirror

### NAMING_CONVENTION
// SOURCE: src/tools.ts:112-120, src/config.ts:42
camelCase functions, PascalCase interfaces, SCREAMING_SNAKE module constants, `.js` suffix on relative imports (Node16 ESM), `node:` prefix on builtins.
```ts
async function readFile(
  args: Record<string, unknown>,
  workingDir: string,
): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  const safePath = assertPathSafe(filePath, workingDir);
```

### ERROR_HANDLING
// SOURCE: src/tools.ts:246-270
Executors throw; `executeTool` converts every throw into `{success:false, output: message}`. Never let a tool error escape the loop.
```ts
  } catch (err) {
    return {
      success: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
```
Config errors: `throw new ConfigError(envKey, raw, "a positive integer")` (src/config.ts:49).

### LOGGING_PATTERN
// SOURCE: src/loop.ts:131-133, eslint.config.js
stdout is the MCP transport. Only `console.error` is allowed (`no-console` lint rule).
```ts
    console.error(
      `[agent] iteration ${iteration}: ${toolCalls.length} tool call(s)`,
    );
```

### TOOL_DEFINITION_PATTERN
// SOURCE: src/tools.ts:39-60
```ts
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file at the given path. ...",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to working directory" },
          content: { type: "string", description: "The full content to write to the file" },
        },
        required: ["path", "content"],
      },
    },
  },
```
Descriptions must exceed 50 characters (asserted in `tools.test.ts:27-31`).

### CONFIG_PATTERN
// SOURCE: src/config.ts:68-73
```ts
  // CONF-04
  const maxIterations = parsePositiveInt("AGENT_MAX_ITERATIONS", 10);
```

### TEST_STRUCTURE
// SOURCE: src/__tests__/tools.test.ts:8-20, 34-39
```ts
let tempDir: string;
const shellMode = "restricted" as const;
const allowedCommands = DEFAULT_ALLOWED_COMMANDS;
const timeoutMs = 5000;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-test-"));
  await fs.writeFile(path.join(tempDir, "test.txt"), "hello world", "utf-8");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("read_file", () => {
  it("reads existing file", async () => {
    const result = await executeTool("read_file", { path: "test.txt" }, tempDir, shellMode, allowedCommands, timeoutMs);
    expect(result.success).toBe(true);
```
Tests live in `src/__tests__/<module>.test.ts`, import from `"../<module>.js"`, vitest `describe/it/expect`.

---

## Files to Change

| File | Action | Responsibility |
|---|---|---|
| `src/tools.ts` | UPDATE | Add `replace_text` definition, executor, dispatch case; refresh `bash` description |
| `src/parser.ts` | UPDATE | Add `replace_text` to `TOOL_SIGNATURES` (first); export `extractToolCalls` and `isKnownTool` |
| `src/config.ts` | UPDATE | `AGENT_NUM_CTX` (optional), defaults 20 / 120 |
| `src/ollama.ts` | UPDATE | `options`, `tool_name` types; clearer fetch-failure message |
| `src/loop.ts` | UPDATE | Termination fix, drop main-call `format`, `num_ctx`, `tool_name`, model-facing clip, new system prompt, `formatAgentResult` |
| `src/index.ts` | UPDATE | Pass `numCtx`; replace inline formatting with `formatAgentResult` |
| `src/__tests__/loop.test.ts` | CREATE | Loop termination, fallback, clip, formatter |
| `src/__tests__/tools.test.ts` | UPDATE | `replace_text` cases; definition count 4 → 5 |
| `src/__tests__/config.test.ts` | UPDATE | New defaults, `AGENT_NUM_CTX` |
| `src/__tests__/parser.test.ts` | UPDATE | `replace_text` signature inference |
| `README.md`, `CLAUDE.md` | UPDATE | Config table, Qwen example, tool list |

## NOT Building

- Worker pool, multiple endpoints, scheduler, health checks, `local_worker_status` (Phase 2)
- Worktree isolation, read-only profiles, dirty-tree handling (Phase 3)
- `local_analyze` / `local_implement` / `local_review` / `local_cancel` (Phase 4)
- Provider interface, OpenAI-compatible provider, streaming (Phase 5)
- Job IDs, persisted logs, token metrics, structured JSON result (Phase 6) — the result stays text
- `apply_patch` (unified diff). Goal doc §10 asks for "one or both"; `replace_text` is the one a 27B model gets right. Add `apply_patch` if real runs show multi-hunk edits failing.
- First-class grep/find/read-range tools (§11) — `bash` with `grep`/`find` covers it for now
- Changing the default `AGENT_MODEL`. The exact Ollama tag for Qwen3.8-27B is not confirmed; document it in README instead.
- `think` control. Add `AGENT_THINK` only if the model's thinking visibly wastes iterations.
- YAML config file, symlink-escape checks, secret redaction (§22-24, later phases)

---

## Step-by-Step Tasks

**Task 0: Install dependencies**
- **ACTION**: `npm install` (there is no `node_modules/` in the checkout).
- **VALIDATE**: `npm test` — record the baseline pass count before changing anything. `npm run typecheck && npm run lint` clean.

### Task 1: Failing tests for `replace_text`
- **ACTION**: In `src/__tests__/tools.test.ts` add `describe("replace_text", ...)` and change the definition-count test to 5.
- **IMPLEMENT**: Cases — (a) replaces a unique match: `{path:"test.txt", old_text:"world", new_text:"there"}` → success, file is `"hello there"`; (b) `old_text` not found → `success:false`, output contains `"not found"`, file unchanged; (c) two occurrences (write `"a a"` first) → `success:false`, output contains `"2 occurrences"`, file unchanged; (d) empty `old_text` → `success:false`; (e) `path:"../../evil.txt"` → output contains `"path not allowed"`.
- **MIRROR**: TEST_STRUCTURE.
- **GOTCHA**: `tsconfig.json` excludes `src/__tests__`, so tests are type-checked only by vitest/eslint.
- **VALIDATE**: `npx vitest run src/__tests__/tools.test.ts` — new cases fail with `unknown tool: replace_text`.

### Task 2: Implement `replace_text`
- **ACTION**: Update `src/tools.ts`.
- **IMPLEMENT**:
  - Definition after `write_file`: name `replace_text`, params `path`, `old_text`, `new_text` (all required). Description: "Replace one exact occurrence of old_text with new_text in an existing file. old_text must match the file exactly, including whitespace, and must appear exactly once — include surrounding lines to make it unique. Prefer this over write_file when changing part of a file."
  - Executor `replaceText(args, workingDir)`: `assertPathSafe`; read file; if `old_text === ""` throw `Error("old_text must not be empty")`; count with `content.split(oldText).length - 1`; 0 → throw `Error("old_text not found in <path>")`; >1 → throw `Error("old_text has N occurrences in <path>; add surrounding context to make it unique")`; else write `content.replace(oldText, () => newText)` and return `replaced 1 occurrence in <path>`.
  - Dispatch: `case "replace_text": return await replaceText(args, workingDir);`
  - `bash` description: append "Use replace_text or write_file for edits, not shell redirection."
- **MIRROR**: TOOL_DEFINITION_PATTERN, NAMING_CONVENTION, ERROR_HANDLING (throw; `executeTool` converts).
- **GOTCHA**: Use the function form of `.replace` — a string replacement interprets `$&`, `$1` in `new_text` and corrupts code containing `$`.
- **VALIDATE**: `npx vitest run src/__tests__/tools.test.ts` all green.

### Task 3: Parser knows `replace_text`; export extraction
- **ACTION**: Update `src/parser.ts` and `src/__tests__/parser.test.ts`.
- **IMPLEMENT**:
  - Test first: content `{"path":"a.ts","old_text":"x","new_text":"y"}` with `noopChatFn` → result `[{function:{name:"replace_text", ...}}]`.
  - `TOOL_SIGNATURES`: insert `replace_text: ["path", "old_text", "new_text"]` as the **first** key.
  - `export function extractToolCalls` (add `export`, no body change).
  - Add `export function isKnownTool(name: string): boolean { return name in TOOL_SIGNATURES; }`.
- **GOTCHA**: `inferToolName` returns the first signature whose keys are all present. `read_file` needs only `path`, so anything more specific must come before it. The existing comment on `write_file` explains this — extend it.
- **VALIDATE**: `npx vitest run src/__tests__/parser.test.ts` green, including all 18 existing cases.

### Task 4: Config — new defaults and `AGENT_NUM_CTX` (test first)
- **ACTION**: Update `src/__tests__/config.test.ts`, then `src/config.ts`.
- **IMPLEMENT**:
  - Tests: add `"AGENT_NUM_CTX"` to `ENV_KEYS`; defaults test expects `maxIterations` 20, `timeoutMs` 120_000, `numCtx` undefined; `AGENT_NUM_CTX=32768` → `numCtx === 32768`; `AGENT_NUM_CTX=abc` throws `ConfigError`.
  - `AppConfig`: add `numCtx?: number`.
  - `loadConfig`: `parsePositiveInt("AGENT_MAX_ITERATIONS", 20)`, `parsePositiveInt("AGENT_TIMEOUT_SECONDS", 120)`, and
    ```ts
    // CONF-08
    const numCtx = process.env.AGENT_NUM_CTX === undefined
      ? undefined
      : parsePositiveInt("AGENT_NUM_CTX", 0);
    ```
    Update the header comment to "CONF-01 through CONF-08".
- **MIRROR**: CONFIG_PATTERN.
- **GOTCHA**: `parsePositiveInt`'s default is never used on this path (the env var is defined); the `0` is a placeholder. Forgetting `AGENT_NUM_CTX` in the test `ENV_KEYS` leaks env between tests.
- **VALIDATE**: `npx vitest run src/__tests__/config.test.ts` green.

### Task 5: Ollama types
- **ACTION**: Update `src/ollama.ts`.
- **IMPLEMENT**: `OllamaMessage` gains `tool_name?: string`. `OllamaChatRequest` gains `options?: { num_ctx?: number }`. Leave `format?: 'json'` as is.
- **VALIDATE**: `npm run typecheck`.

### Task 6: Failing loop tests
- **ACTION**: Create `src/__tests__/loop.test.ts`.
- **IMPLEMENT**: Mock the transport:
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { chatWithOllama } from "../ollama.js";
  import { runAgentLoop } from "../loop.js";
  vi.mock("../ollama.js", () => ({ chatWithOllama: vi.fn() }));
  const chat = vi.mocked(chatWithOllama);
  const reply = (message: object) => ({ message: { role: "assistant", content: "", ...message }, done: true });
  ```
  Base options: temp dir as `workingDir` (mirror TEST_STRUCTURE), `maxIterations: 5`, `shellMode: "none"`, `allowedCommands: []`, `timeoutMs: 5000`, `model: "m"`, `host: "http://x"`.
  Cases:
  1. **Prose ends the job** — replies: native `tool_calls` for `read_file test.txt`, then `{content:"All done."}`. Expect `finalMessage === "All done."`, `parseFailure` undefined, `chat` called exactly 2 times, `steps.length === 1`.
  2. **Text tool call still works** — reply 1 content `I'll read it: {"name":"read_file","parameters":{"path":"test.txt"}}`, reply 2 prose. Expect 1 step with `toolName "read_file"`.
  3. **Malformed JSON attempt still retries** — reply 1 content `{"name": "read_file", "parameters": {"path": ` (truncated), reply 2 (the correction call) a valid JSON tool call, reply 3 prose. Expect 1 step, 3 chat calls.
  4. **Main call sends no `format`; tool message has `tool_name`** — after case 1, `chat.mock.calls[0][1].format` is undefined and the second call's messages include `{role:"tool", tool_name:"read_file"}`.
  5. **`numCtx` forwarded** — with `numCtx: 8192`, `chat.mock.calls[0][1].options` equals `{num_ctx: 8192}`; without it, `options` is undefined.
  6. **Model-facing clip** — write a 50 000-char file, have the model read it; the tool message content length is ≤ 16 100 and contains `[... clipped`; `steps[0].result.output.length` is still 50 000.
- **GOTCHA**: `vi.mock` is hoisted; call `chat.mockReset()` in `beforeEach`. Messages are mutated in place by the loop, so assert on `chat.mock.calls[n][1].messages` only for fields, not array length.
- **VALIDATE**: `npx vitest run src/__tests__/loop.test.ts` — case 1 fails (4 chat calls / parseFailure set), 4-6 fail.

### Task 7: Fix termination and drop main-call `format`
- **ACTION**: Update `src/loop.ts:79-128`.
- **IMPLEMENT**:
  - Import `extractToolCalls, isKnownTool` alongside `parseToolCall`.
  - Remove `format: 'json'` from the main `chatWithOllama` call. Keep it in `chatFn`.
  - Replace the Tier 2+3 block:
    ```ts
    // Tier 2: text extraction. Tier 3 (retry) only when the content is a
    // broken tool-call attempt — plain prose means the model is done.
    if (!toolCalls || toolCalls.length === 0) {
      const content = assistantMessage.content;
      const extracted = extractToolCalls(content);
      if (extracted && isKnownTool(extracted[0]!.function.name)) {
        toolCalls = extracted;
      } else if (/^\s*(```|[{[]|<tool_call>)/.test(content)) {
        const parseResult = await parseToolCall(content, chatFn);
        if ("reason" in parseResult) { /* existing ParseFailure return, unchanged */ }
        toolCalls = parseResult;
      }
    }
    ```
  - The existing "no tool calls → finalMessage, break" branch now handles prose.
- **GOTCHA**: Preserve LOOP-04 — `messages.push(assistantMessage)` stays before any parsing. JSON-looking content with an unknown tool name still goes through `parseToolCall`, gets executed, and the model sees `unknown tool: x` — that feedback path is intentional, keep it. `Array.isArray` narrowing: `"reason" in parseResult` is enough since arrays have no `reason` key; drop the old `as` casts.
- **VALIDATE**: loop tests 1-4 (except `tool_name`) green; `npx vitest run src/__tests__/parser.test.ts` still green.

### Task 8: `tool_name`, `num_ctx`, model-facing clip
- **ACTION**: Update `src/loop.ts`.
- **IMPLEMENT**:
  - Options gain `numCtx?: number`. Build once: `const ollamaOptions = numCtx ? { num_ctx: numCtx } : undefined;` and spread `...(ollamaOptions && { options: ollamaOptions })` into both `chatWithOllama` calls.
  - Tool message: `messages.push({ role: "tool", tool_name: name, content: clipForModel(result.output) });`
  - Module-level:
    ```ts
    const MAX_TOOL_OUTPUT_CHARS = 16_000;

    // Keeps head and tail: errors usually sit at the end of command output.
    function clipForModel(output: string): string {
      if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
      const half = MAX_TOOL_OUTPUT_CHARS / 2;
      return `${output.slice(0, half)}\n[... clipped ${output.length - MAX_TOOL_OUTPUT_CHARS} chars ...]\n${output.slice(-half)}`;
    }
    ```
- **GOTCHA**: `steps[]` keeps the unclipped output; only the model-facing message is clipped. LOOP-03 still holds — a tool message is pushed for every call, errors included.
- **VALIDATE**: all 6 loop tests green.

### Task 9: System prompt
- **ACTION**: Replace `SYSTEM_PROMPT` in `src/loop.ts:33-34`.
- **IMPLEMENT**:
  ```ts
  const SYSTEM_PROMPT = [
    "You are a coding worker completing one bounded task delegated by a supervisor.",
    "Rules:",
    "- Do only the delegated task. Do not broaden scope or touch unrelated files.",
    "- Read a file before editing it. Never invent file contents.",
    "- Prefer replace_text for edits; use write_file only for new files or full rewrites.",
    "- Make the smallest change that works and match the existing code style.",
    "- Run any validation command the task names. Never say a command passed unless you ran it and saw it pass.",
    "- If the same operation fails twice, stop retrying it and report the failure.",
    "- Do not commit, push, or access paths outside the working directory.",
    "When finished, reply with plain text and no tool call: what you did, files changed, commands run and their results, and anything unresolved or uncertain.",
  ].join("\n");
  ```
- **VALIDATE**: `npm run typecheck`; loop tests still green.

### Task 10: `formatAgentResult` (test first)
- **ACTION**: Add tests to `loop.test.ts`, then export `formatAgentResult(result: AgentResult, maxIterations: number): string` from `src/loop.ts`, moving the logic out of `src/index.ts:55-92`.
- **IMPLEMENT**: Same line format as today, with these changes:
  - failed step: `→ failed: <last 500 chars of output>` (was the entire output, up to 1 MB; "blocked" was also wrong for a failing test run);
  - successful step over 200 chars: `N lines` (unchanged);
  - `parseFailure`: append `rawContent` clipped to 500 chars after the existing bracket line;
  - empty `finalMessage` with no `stoppedByLimit` and no `parseFailure`: append `[model returned an empty final message]`.
  Tests: a step with 5 000-char failure output yields a line under 700 chars that contains the output's last 20 chars; `stoppedByLimit` line includes the limit; empty-final case.
- **MIRROR**: existing formatting in `src/index.ts:58-76`.
- **VALIDATE**: `npx vitest run src/__tests__/loop.test.ts` green.

### Task 11: Wire `index.ts`
- **ACTION**: Update `src/index.ts`.
- **IMPLEMENT**: pass `numCtx: config.numCtx` to `runAgentLoop`; replace lines 55-92 with `const responseText = formatAgentResult(result, config.maxIterations);`; import it. Tool description: "Run a bounded coding task on a local model. The agent can read, edit (replace_text), and write files, list directories, and run shell commands, and returns a concise report." Startup line: append `| ctx: ${config.numCtx ?? "default"}`.
- **VALIDATE**: `npm run typecheck && npm run lint && npm run build`.

### Task 12: Clearer fetch failure
- **ACTION**: Update the `catch` in `src/ollama.ts:55-59`.
- **IMPLEMENT**:
  ```ts
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
      // ponytail: non-streaming request hit Node fetch's response timeout; switch to stream:true when the provider layer lands
      throw new Error(`Ollama at ${host} did not respond in time -- the generation is too long for a non-streaming request`);
    }
    throw new Error(`Ollama is not running at ${host} -- start it with: ollama serve`);
  }
  ```
- **GOTCHA**: The undici error codes are from memory. If a real timeout shows a different `cause.code`, adjust — the fallback message is unchanged either way.
- **VALIDATE**: `npm run typecheck`. No unit test; covered by manual validation.

### Task 13: Docs
- **ACTION**: Update `README.md` and `CLAUDE.md`.
- **IMPLEMENT**: README config table — defaults 20 / 120, new row `AGENT_NUM_CTX | *(Ollama default)* | Context window sent as options.num_ctx; set it for long tasks (e.g. 32768)`; fix README line 69 ("default 10" → 20); add a Qwen 27B example `env` block (`AGENT_MODEL`, `AGENT_NUM_CTX=32768`, `OLLAMA_HOST`) with a note to confirm the tag via `ollama list`; mention `replace_text` wherever the three file tools are listed (incl. line 160). CLAUDE.md "What the Local Agent Can Access": add `replace_text — exact, unique-match edit of part of a file`.
- **GOTCHA**: CLAUDE.md is deliberately model-agnostic (commit `eb1156c`) — no model names or personal paths there.
- **VALIDATE**: `grep -n "AGENT_NUM_CTX\|replace_text" README.md CLAUDE.md` shows the new entries.

### Task 14: Full validation and live check
- **ACTION**: Run every command under Validation Commands, then the manual checklist against a real Ollama.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| replace_text unique | `old_text:"world"` in `"hello world"` | file `"hello there"` | |
| replace_text missing | `old_text:"zzz"` | fail, "not found", file unchanged | yes |
| replace_text ambiguous | `"a a"`, `old_text:"a"` | fail, "2 occurrences" | yes |
| replace_text `$` in new_text | `new_text:"$&x"` | literal `$&x` written | yes |
| replace_text traversal | `path:"../../evil.txt"` | "path not allowed" | yes |
| parser infers replace_text | `{path, old_text, new_text}` | name `replace_text` | yes (ordering) |
| config defaults | no env | 20, 120 000, numCtx undefined | |
| config AGENT_NUM_CTX invalid | `abc` | `ConfigError` | yes |
| loop prose terminates | tool call then prose | 2 chat calls, finalMessage set | core |
| loop text tool call | prose + embedded JSON | 1 step | |
| loop broken JSON retries | truncated JSON | correction call made | yes |
| loop clip | 50 000-char file | tool message ≤ ~16 100 chars | yes |
| formatter failure clip | 5 000-char failure | line < 700 chars, tail kept | yes |

Add the `$&` case to Task 1's list.

### Edge Cases Checklist
- [x] Empty input — empty `old_text`; empty final message
- [x] Maximum size input — 50 000-char tool output clipped for the model
- [x] Invalid types — `String(args.x ?? "")` coercion, as existing executors do
- [ ] Concurrent access — out of scope (Phase 2/3)
- [x] Network failure — fetch error message (Task 12), manual only
- [x] Permission denied — path traversal rejected

---

## Validation Commands

### Static Analysis
```bash
npm run typecheck && npm run lint
```
EXPECT: Zero type errors, zero lint errors

### Unit Tests
```bash
npx vitest run src/__tests__/loop.test.ts src/__tests__/tools.test.ts src/__tests__/config.test.ts src/__tests__/parser.test.ts
```
EXPECT: All pass

### Full Test Suite
```bash
npm test && npm run build
```
EXPECT: No regressions against the Task 0 baseline; `build/index.js` emitted

### Manual Validation (needs Ollama with the target model pulled)
- [ ] `ollama list` — note the exact Qwen tag; set `AGENT_MODEL` and `AGENT_NUM_CTX=32768`
- [ ] `run_local_agent`: "Read src/security.ts. List the exported function names. Do not read other files." → ends with a prose answer, **no** `[parse failed ...]` line, stderr shows 1-2 iterations
- [ ] In a scratch copy: "Read src/config.ts. Using replace_text, change the default AGENT_MAX_ITERATIONS from 20 to 25. Do not read other files." → `git diff` shows a one-line change
- [ ] Watch stderr for whether tool calls arrive natively or through text extraction — this is the "verify tool-call format" item from the goal doc. If native calls never appear, check the model's Ollama template before touching the parser.
- [ ] Stop Ollama, call the tool → "Ollama is not running at ..." error, `isError: true`

---

## Acceptance Criteria
- [ ] A prose final answer ends the job with `finalMessage` set and no parse failure
- [ ] Main chat call sends no `format`; correction call still sends `format: "json"`
- [ ] `replace_text` works, refuses missing/ambiguous matches, and is path-contained
- [ ] `AGENT_NUM_CTX` reaches Ollama as `options.num_ctx`; unset sends no `options`
- [ ] Defaults are 20 iterations / 120 s; README matches
- [ ] Supervisor-facing result never includes more than 500 chars of any single failure output
- [ ] `run_local_agent` input schema unchanged
- [ ] typecheck, lint, test, build all pass

## Completion Checklist
- [ ] Code follows discovered patterns
- [ ] Error handling matches codebase style (throw in executor, convert in `executeTool`)
- [ ] Only `console.error` used
- [ ] Tests follow test patterns
- [ ] No hardcoded values beyond the two named clip constants
- [ ] README and CLAUDE.md updated
- [ ] No unnecessary scope additions
- [ ] Self-contained — no questions needed during implementation

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A final summary that starts with a code fence or `{` is mistaken for a broken tool call and triggers retries | Low | Medium | System prompt asks for plain text; worst case is today's behaviour. Tighten the regex if seen live. |
| A final summary quoting a valid known-tool JSON snippet gets executed | Low | Low | Only known tool names qualify; the result feeds back and the model can finish next turn |
| Qwen3.8 on Ollama emits tool calls in a format neither path handles | Medium | High | Manual validation step observes it; parser already handles `<tool_call>{...}` via prose stripping |
| Long generations hit fetch's response timeout | Medium | Medium | Task 12 makes it diagnosable; streaming deferred to Phase 5 |
| Thinking output inflates iterations/latency | Medium | Medium | Deferred `AGENT_THINK`; one-line addition to `options`-style plumbing if needed |
| Raised 120 s command timeout lets a hung command block longer | Low | Low | Env override unchanged |

## Notes
- The goal doc is XL (6 phases, 23 acceptance criteria). This plan covers Phase 1 only; Phases 2-6 each warrant their own plan. Phase 2 (worker pool) is the doc's "first major milestone" and will want `runAgentLoop` to take a `host` per call — it already does, so nothing here blocks it.
- Verified by reading source: the termination defect, the `format:"json"` on every call, the missing `tool_name`, the 1 MB failure passthrough in `index.ts:74`. Verified against fetched Ollama docs: `tool_name`, `options`, `think`, argument object shape. **Not verified**: anything at runtime — `node_modules/` is absent, so no test, typecheck, or lint was run while planning; and the undici timeout codes are from memory.
- The repo has no `.claude/STATE.md`; if Phases 2-6 will span sessions, `claude-memory-init` is worth running before implementation starts.
- Per project `CLAUDE.md`, Tasks 1, 2, 4, 5, 13 are single-file mechanical edits suitable for `run_local_agent` — but the loop is broken in exactly the way this plan fixes, so do Tasks 6-8 directly first.
