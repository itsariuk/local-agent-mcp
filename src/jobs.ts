// Per-job records on disk and in-process metrics. Writes are best effort:
// a failed write is logged, never surfaced to the job.

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentResult, TokenUsage } from "./loop.js";

// ---------------------------------------------------------------------------
// Record types (snake_case: they are read by the supervisor and by humans)
// ---------------------------------------------------------------------------

export interface JobRequestRecord {
  job_id: string;
  tool: string;
  mode: string;
  prompt: string;
  worker: string;
  provider: string;
  model: string;
  max_iterations: number;
  timeout_seconds: number;
  started_at: string;
}

export interface JobResultRecord {
  job_id: string;
  status: string;
  iterations: number;
  elapsed_ms: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
  tool_calls: number;
  files_read: string[];
  files_changed: string[];
  commands_run: Array<{ command: string; success: boolean }>;
  chars_consumed: number; // tool output + assistant text the worker processed
  chars_returned: number; // what the supervisor received
  finished_at: string;
  worktree?: string; // only when it was kept for inspection
  error?: string;
}

export interface JobRecord {
  request?: JobRequestRecord;
  result?: JobResultRecord;
  transcript: unknown[];
}

// Job ids are 8 hex chars from randomUUID(); nothing else may become a path
const JOB_ID = /^[0-9a-f]{8}$/;

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

export async function writeJobRecord(
  dir: string,
  id: string,
  files: {
    request?: JobRequestRecord;
    result?: JobResultRecord;
    transcript?: unknown[];
    patch?: string;
  },
): Promise<void> {
  if (!JOB_ID.test(id)) return;
  const jobDir = path.join(dir, id);
  try {
    await fs.mkdir(jobDir, { recursive: true });
    const writes: Promise<void>[] = [];
    if (files.request) {
      writes.push(
        fs.writeFile(path.join(jobDir, "request.json"), JSON.stringify(files.request, null, 2)),
      );
    }
    if (files.result) {
      writes.push(
        fs.writeFile(path.join(jobDir, "result.json"), JSON.stringify(files.result, null, 2)),
      );
    }
    if (files.transcript) {
      const lines = files.transcript.map((m) => JSON.stringify(m)).join("\n");
      writes.push(fs.writeFile(path.join(jobDir, "transcript.jsonl"), lines + (lines ? "\n" : "")));
    }
    if (files.patch) {
      writes.push(fs.writeFile(path.join(jobDir, "patch.diff"), files.patch));
    }
    await Promise.all(writes);
  } catch (err) {
    console.error(`[jobs] failed to write ${jobDir}: ${err instanceof Error ? err.message : err}`);
  }
}

/** The stored record, or undefined when there is none. `tail` limits transcript entries from the end. */
export async function readJobRecord(
  dir: string,
  id: string,
  tail = 20,
): Promise<JobRecord | undefined> {
  if (!JOB_ID.test(id)) return undefined;
  const jobDir = path.join(dir, id);
  const readJson = async <T>(name: string): Promise<T | undefined> => {
    try {
      return JSON.parse(await fs.readFile(path.join(jobDir, name), "utf-8")) as T;
    } catch {
      return undefined;
    }
  };
  const [request, result] = await Promise.all([
    readJson<JobRequestRecord>("request.json"),
    readJson<JobResultRecord>("result.json"),
  ]);
  if (!request && !result) return undefined;

  let transcript: unknown[] = [];
  try {
    const text = await fs.readFile(path.join(jobDir, "transcript.jsonl"), "utf-8");
    transcript = text
      .split("\n")
      .filter(Boolean)
      .slice(-tail)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    // no transcript (the job may still be running, or the write failed)
  }
  return { request, result, transcript };
}

// ---------------------------------------------------------------------------
// Derived from an AgentResult
// ---------------------------------------------------------------------------

export type ResultSummary = Pick<
  JobResultRecord,
  "tool_calls" | "files_read" | "files_changed" | "commands_run" | "chars_consumed"
>;

export function summarizeResult(result: AgentResult): ResultSummary {
  const filesRead = new Set<string>();
  const filesChanged = new Set<string>();
  const commandsRun: ResultSummary["commands_run"] = [];
  let chars = 0;
  for (const step of result.steps) {
    chars += step.result.output.length;
    const file = typeof step.args.path === "string" ? step.args.path : undefined;
    if (step.toolName === "read_file" && file) filesRead.add(file);
    if (
      (step.toolName === "write_file" || step.toolName === "replace_text") &&
      file &&
      step.result.success
    ) {
      filesChanged.add(file);
    }
    if (step.toolName === "bash") {
      commandsRun.push({ command: String(step.args.command ?? ""), success: step.result.success });
    }
  }
  for (const m of result.messages) if (m.role === "assistant") chars += m.content.length;
  return {
    tool_calls: result.steps.length,
    files_read: [...filesRead],
    files_changed: [...filesChanged],
    commands_run: commandsRun,
    chars_consumed: chars,
  };
}

export function toUsageRecord(usage?: TokenUsage): JobResultRecord["usage"] {
  return usage
    ? { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens }
    : undefined;
}

// ---------------------------------------------------------------------------
// In-process metrics (per server lifetime; the records on disk are the durable source)
// ---------------------------------------------------------------------------

export interface MetricsSnapshot {
  jobs: Record<string, number>;
  tokens: { prompt: number; completion: number };
  tool_calls: number;
  chars_consumed: number;
  chars_returned: number;
  supervisor_context_saved_chars: number;
  since: string;
}

export class Metrics {
  readonly since = new Date().toISOString();
  private readonly jobs: Record<string, number> = { started: 0 };
  private readonly tokens = { prompt: 0, completion: 0 };
  private toolCalls = 0;
  private charsConsumed = 0;
  private charsReturned = 0;

  started(): void {
    this.jobs.started = (this.jobs.started ?? 0) + 1;
  }

  finished(
    result: Pick<
      JobResultRecord,
      "status" | "tool_calls" | "chars_consumed" | "chars_returned" | "usage"
    >,
  ): void {
    this.jobs[result.status] = (this.jobs[result.status] ?? 0) + 1;
    this.toolCalls += result.tool_calls;
    this.charsConsumed += result.chars_consumed;
    this.charsReturned += result.chars_returned;
    if (result.usage) {
      this.tokens.prompt += result.usage.prompt_tokens;
      this.tokens.completion += result.usage.completion_tokens;
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      jobs: { ...this.jobs },
      tokens: { ...this.tokens },
      tool_calls: this.toolCalls,
      chars_consumed: this.charsConsumed,
      chars_returned: this.charsReturned,
      // A lower bound in characters: what the worker read and produced that the supervisor never saw
      supervisor_context_saved_chars: Math.max(0, this.charsConsumed - this.charsReturned),
      since: this.since,
    };
  }
}
