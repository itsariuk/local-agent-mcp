// Agent loop — orchestrates Ollama calls and tool execution.

import { chatWithOllama } from "./ollama.js";
import type { OllamaMessage, OllamaToolCall } from "./ollama.js";
import { executeTool, TOOL_DEFINITIONS } from "./tools.js";
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
  } = options;

  const ollamaOptions = numCtx ? { options: { num_ctx: numCtx } } : {};

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  const steps: LoopStep[] = [];
  let iteration = 0;
  let finalMessage = "";
  let stoppedByLimit = false;

  // chatFn for parser retry loop — isolated from main conversation history (per D-03)
  const chatFn = async (correctionMessages: OllamaMessage[]): Promise<OllamaMessage> => {
    const response = await chatWithOllama(host, {
      model,
      messages: correctionMessages,
      tools: TOOL_DEFINITIONS,
      stream: false as const,
      format: "json",
      ...ollamaOptions,
    });
    return response.message;
  };

  while (iteration < maxIterations) {
    iteration++;

    const response = await chatWithOllama(host, {
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      stream: false as const,
      ...ollamaOptions,
    });

    const assistantMessage = response.message;

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
      const name = tc.function.name;
      const args = tc.function.arguments; // Pre-parsed object, do NOT JSON.parse

      const result = await executeTool(
        name,
        args,
        workingDir,
        shellMode,
        allowedCommands,
        timeoutMs,
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

export function formatAgentResult(result: AgentResult, maxIterations: number): string {
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

  if (result.parseFailure) {
    logLines.push(
      `[parse failed after ${result.parseFailure.attemptCount} attempts: ${result.parseFailure.reason}]`,
      result.parseFailure.rawContent.slice(0, MAX_REPORT_EXCERPT_CHARS),
    );
  } else if (!result.stoppedByLimit && result.finalMessage.trim() === "") {
    logLines.push("[model returned an empty final message]");
  }

  const executionLog = logLines.length > 0 ? logLines.join("\n") + "\n\n" : "";
  return executionLog + result.finalMessage;
}
