// Agent loop — orchestrates Ollama calls and tool execution.

import { chatWithOllama } from "./ollama.js";
import type { OllamaMessage, OllamaToolCall } from "./ollama.js";
import { executeTool, toolDefinitions } from "./tools.js";
import type { ToolResult } from "./tools.js";
import type { ShellMode } from "./security.js";
import { parseToolCall, classifyText } from "./parser.js";
import type { ParseFailure } from "./parser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopStep {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
}

export interface AgentResult {
  steps: LoopStep[];
  finalMessage: string;
  iterationCount: number;
  stoppedByLimit: boolean;
  parseFailure?: ParseFailure; // per D-08
  aborted?: "cancelled" | "timed_out";
}

export type JobStatus =
  | "completed"
  | "stopped_at_limit"
  | "parse_failed"
  | "cancelled"
  | "timed_out";

export function jobStatus(result: AgentResult): JobStatus {
  if (result.aborted) return result.aborted;
  if (result.parseFailure) return "parse_failed";
  if (result.stoppedByLimit) return "stopped_at_limit";
  return "completed";
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

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

const ANALYZE_PROMPT = [
  "You are a read-only repository analyst completing one bounded investigation for a supervisor.",
  "You cannot modify files; only inspection commands are available.",
  "Rules:",
  "- Answer only the delegated question. Do not broaden scope.",
  "- Use tools to gather evidence. Never invent file contents or claim to have run something you did not run.",
  "- Cite file paths and line numbers for every finding.",
  "When finished, reply with plain text and no tool call: findings with evidence, concise conclusions, and anything uncertain.",
].join("\n");

const MAX_TOOL_OUTPUT_CHARS = 16_000;
const MAX_REPORT_EXCERPT_CHARS = 500;

// Keeps head and tail: errors usually sit at the end of command output.
function clipForModel(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const half = MAX_TOOL_OUTPUT_CHARS / 2;
  return `${output.slice(0, half)}\n[... clipped ${output.length - MAX_TOOL_OUTPUT_CHARS} chars ...]\n${output.slice(-half)}`;
}

export async function runAgentLoop(options: {
  prompt: string;
  model: string;
  host: string;
  workingDir: string;
  maxIterations: number;
  shellMode: ShellMode;
  allowedCommands: readonly string[];
  timeoutMs: number;
  numCtx?: number;
  readOnly?: boolean;
  signal?: AbortSignal;
}): Promise<AgentResult> {
  const {
    prompt,
    model,
    host,
    workingDir,
    maxIterations,
    shellMode,
    allowedCommands,
    timeoutMs,
    numCtx,
    readOnly = false,
    signal,
  } = options;

  // AbortSignal.timeout sets a TimeoutError reason; local_cancel passes a plain Error
  const abortedAs = (): AgentResult["aborted"] =>
    signal?.aborted
      ? (signal.reason as { name?: string } | undefined)?.name === "TimeoutError"
        ? "timed_out"
        : "cancelled"
      : undefined;

  const tools = toolDefinitions(readOnly);

  const ollamaOptions = numCtx ? { options: { num_ctx: numCtx } } : {};

  const messages: OllamaMessage[] = [
    { role: "system", content: readOnly ? ANALYZE_PROMPT : SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  const steps: LoopStep[] = [];
  let iteration = 0;
  let finalMessage = "";
  let stoppedByLimit = false;

  // chatFn for parser retry loop — isolated from main conversation history (per D-03)
  const chatFn = async (correctionMessages: OllamaMessage[]): Promise<OllamaMessage> => {
    const response = await chatWithOllama(
      host,
      {
        model,
        messages: correctionMessages,
        tools,
        stream: false as const,
        format: "json",
        ...ollamaOptions,
      },
      signal,
    );
    return response.message;
  };

  while (iteration < maxIterations) {
    if (signal?.aborted) break;
    iteration++;

    let assistantMessage: OllamaMessage;
    try {
      const response = await chatWithOllama(
        host,
        { model, messages, tools, stream: false as const, ...ollamaOptions },
        signal,
      );
      assistantMessage = response.message;
    } catch (err) {
      if (signal?.aborted) break; // cancelled/timed out mid-request: keep what we have
      throw err;
    }

    // CRITICAL (LOOP-04): Append assistant message BEFORE processing tool results
    messages.push(assistantMessage);

    // Tier 1: native tool_calls (PARSE-01 fast path)
    let toolCalls: OllamaToolCall[] | null = assistantMessage.tool_calls ?? null;

    // Tier 2: text extraction. Tier 3 (retry) only for a broken tool-call
    // attempt — anything else without a call means the model is done.
    if (!toolCalls || toolCalls.length === 0) {
      const content = assistantMessage.content;
      const verdict = classifyText(content);

      if (Array.isArray(verdict)) {
        toolCalls = verdict;
      } else if (verdict === "broken") {
        const parseResult = await parseToolCall(content, chatFn);
        // parseToolCall swallows an aborted chatFn as a retry failure; do not report that as parse_failed
        if (signal?.aborted) break;

        // Check for ParseFailure (per D-07)
        if ("reason" in parseResult) {
          // Per D-07: append synthetic tool result message to history before breaking
          messages.push({
            role: "tool" as const,
            content: `[parse failed: ${parseResult.reason}]`,
          });

          return {
            steps,
            finalMessage: "",
            iterationCount: iteration,
            stoppedByLimit: false,
            parseFailure: parseResult,
          };
        }

        toolCalls = parseResult;
      }
    }

    // If no tool calls, the model is done
    if (!toolCalls || toolCalls.length === 0) {
      finalMessage = assistantMessage.content;
      break;
    }

    // Log iteration to stderr
    console.error(`[agent] iteration ${iteration}: ${toolCalls.length} tool call(s)`);

    // Process each tool call
    for (const tc of toolCalls) {
      if (signal?.aborted) break; // the rest of the batch must not run after a cancel
      const name = tc.function.name;
      const args = tc.function.arguments; // Pre-parsed object, do NOT JSON.parse

      const result = await executeTool(
        name,
        args,
        workingDir,
        shellMode,
        allowedCommands,
        timeoutMs,
        readOnly,
        signal,
      );

      steps.push({ toolName: name, args, result });

      // LOOP-03: Always append tool result as role:tool, even on error
      messages.push({
        role: "tool",
        tool_name: name,
        content: clipForModel(result.output),
      });
    }
  }

  const aborted = abortedAs();
  if (aborted) {
    return { steps, finalMessage: "", iterationCount: iteration, stoppedByLimit: false, aborted };
  }

  // Check if stopped by iteration limit
  if (iteration >= maxIterations && steps.length > 0) {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.role === "tool") {
      // Last iteration had tool calls — model never got to respond
      stoppedByLimit = true;
      finalMessage = "";
    }
  }

  return { steps, finalMessage, iterationCount: iteration, stoppedByLimit };
}

// ---------------------------------------------------------------------------
// Supervisor-facing report
// ---------------------------------------------------------------------------

export interface RunInfo {
  workerId: string;
  model: string;
  jobId: string;
  elapsedMs: number; // includes time spent queued — the latency the supervisor saw
  mode: string;
}

export function formatAgentResult(
  result: AgentResult,
  maxIterations: number,
  run?: RunInfo,
): string {
  const logLines: string[] = [];

  for (const step of result.steps) {
    const argsStr = Object.entries(step.args)
      .map(([k, v]) => {
        const val =
          typeof v === "string" && v.length > 80 ? v.slice(0, 80) + "..." : JSON.stringify(v);
        return `${k}=${val}`;
      })
      .join(", ");

    if (step.result.success) {
      const summary =
        step.result.output.length > 200
          ? `${step.result.output.split("\n").length} lines`
          : step.result.output.trim();
      logLines.push(`${step.toolName}(${argsStr}) → ${summary}`);
    } else {
      const tail = step.result.output.trim().slice(-MAX_REPORT_EXCERPT_CHARS);
      logLines.push(`${step.toolName}(${argsStr}) → failed: ${tail}`);
    }
  }

  if (result.stoppedByLimit) {
    logLines.push(`[stopped: max iterations reached (${maxIterations})]`);
  }

  if (result.aborted) {
    const what = result.aborted === "timed_out" ? "timed out" : "cancelled";
    logLines.push(`[${what} after ${result.iterationCount} iterations; work so far is above]`);
  }

  if (result.parseFailure) {
    logLines.push(
      `[parse failed after ${result.parseFailure.attemptCount} attempts: ${result.parseFailure.reason}]`,
      result.parseFailure.rawContent.slice(0, MAX_REPORT_EXCERPT_CHARS),
    );
  } else if (!result.stoppedByLimit && !result.aborted && result.finalMessage.trim() === "") {
    logLines.push("[model returned an empty final message]");
  }

  const executionLog = logLines.length > 0 ? logLines.join("\n") + "\n\n" : "";
  const header = run
    ? `[worker ${run.workerId} | ${run.model} | job ${run.jobId} | ${(run.elapsedMs / 1000).toFixed(1)}s | ${result.iterationCount} iterations | mode ${run.mode} | status ${jobStatus(result)}]\n`
    : "";
  return header + executionLog + result.finalMessage;
}

const MAX_DIFF_CHARS = 200_000;

/** Implement-mode tail: changed files and the unified diff, clipped for the supervisor. */
export function formatDiff(patch: string, files: string[]): string {
  if (files.length === 0) return "\n\n[no files changed]";
  const clipped =
    patch.length > MAX_DIFF_CHARS
      ? `${patch.slice(0, MAX_DIFF_CHARS)}\n[diff truncated: ${patch.length - MAX_DIFF_CHARS} more chars; re-run with a narrower task]`
      : patch;
  return `\n\n--- changes (${files.length} files) ---\n${files.join("\n")}\n\n${clipped}`;
}
