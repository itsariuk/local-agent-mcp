#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { runAgentLoop, formatAgentResult, formatDiff } from "./loop.js";
import type { AgentResult } from "./loop.js";
import { createWorktree, captureDiff, removeWorktree } from "./worktree.js";
import { loadConfig, ConfigError } from "./config.js";
import type { AppConfig } from "./config.js";
import { WorkerPool } from "./pool.js";
import { analyzePrompt, implementPrompt, reviewPrompt } from "./prompts.js";
import { createProvider } from "./provider.js";
import { Metrics, writeJobRecord, readJobRecord, summarizeResult, toUsageRecord } from "./jobs.js";
import type { JobResultRecord } from "./jobs.js";
import { jobStatus, LoopError } from "./loop.js";

// ---------------------------------------------------------------------------
// Configuration (fail-fast on invalid env vars)
// ---------------------------------------------------------------------------

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Job runner shared by every job tool
// ---------------------------------------------------------------------------

const pool = new WorkerPool(config.workers, (w) => createProvider(w, config.apiKey).health());
const metrics = new Metrics();
const workerIds = config.workers.map((w) => w.id).join(", ");

type Mode = "analyze" | "implement" | "direct";

interface JobArgs {
  tool: string;
  prompt: string;
  mode: Mode;
  worker?: string;
  model?: string;
  max_iterations?: number;
  timeout_seconds?: number;
}

async function runJob(args: JobArgs, clientSignal: AbortSignal): Promise<string> {
  const { prompt, mode } = args;
  const maxIterations = args.max_iterations ?? config.maxIterations;
  const timeoutSeconds = args.timeout_seconds ?? config.jobTimeoutMs / 1000;
  const started = Date.now();

  // Record writes start inside the job but are awaited only after the worker is
  // released: the disk never holds a GPU, and the client never gets a response
  // before its record exists (a client that exits right away would lose it).
  const pendingWrites: Promise<void>[] = [];

  try {
    return await pool.run(
      async (w, jobId, jobSignal) => {
        const model = args.model ?? w.model;
        const provider = createProvider(w, config.apiKey);
        metrics.started();
        // Written before the loop so a crash still leaves the request behind
        pendingWrites.push(
          writeJobRecord(config.jobLogDir, jobId, {
            request: {
              job_id: jobId,
              tool: args.tool,
              mode,
              prompt,
              worker: w.id,
              provider: w.provider,
              model,
              max_iterations: maxIterations,
              timeout_seconds: timeoutSeconds,
              started_at: new Date(started).toISOString(),
            },
          }),
        );

        const finish = (record: Omit<JobResultRecord, "job_id" | "elapsed_ms" | "finished_at">) => {
          const full: JobResultRecord = {
            job_id: jobId,
            ...record,
            elapsed_ms: Date.now() - started,
            finished_at: new Date().toISOString(),
          };
          metrics.finished(full);
          return full;
        };
        const nothing = {
          tool_calls: 0,
          files_read: [],
          files_changed: [],
          commands_run: [],
          chars_consumed: 0,
        };

        let wt: Awaited<ReturnType<typeof createWorktree>> | undefined;
        let result: AgentResult | undefined;
        let diff: { patch: string; files: string[] } | undefined;
        try {
          wt = mode === "implement" ? await createWorktree(config.workingDir, jobId) : undefined;
          // The clock starts once the job has a worker, so queue time does not count
          const signal = AbortSignal.any([jobSignal, AbortSignal.timeout(timeoutSeconds * 1000)]);
          result = await runAgentLoop({
            prompt,
            model,
            provider,
            workingDir: wt ? path.join(wt.path, wt.relativeDir) : config.workingDir,
            maxIterations,
            shellMode: config.shellMode,
            allowedCommands: config.allowedCommands,
            timeoutMs: config.timeoutMs,
            numCtx: config.numCtx,
            readOnly: mode === "analyze",
            signal,
          });
          if (wt) diff = await captureDiff(wt.path);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A backend failure mid-job still leaves a transcript worth keeping
          const partial = err instanceof LoopError ? err.partial : result;
          const record = finish({
            status: message.startsWith("blocked:") ? "blocked" : "failed",
            iterations: partial?.iterationCount ?? 0,
            ...(partial ? summarizeResult(partial) : nothing),
            usage: toUsageRecord(partial?.usage),
            chars_returned: 0,
            error: message,
            ...(wt && { worktree: wt.path }),
          });
          pendingWrites.push(
            writeJobRecord(config.jobLogDir, jobId, {
              result: record,
              transcript: partial?.messages,
            }),
          );
          // Keep the worktree for inspection and say where it is
          throw wt ? new Error(`${message} (worktree kept at ${wt.path})`, { cause: err }) : err;
        }

        let text = formatAgentResult(result, maxIterations, {
          workerId: w.id,
          model,
          jobId,
          elapsedMs: Date.now() - started,
          mode,
        });
        if (wt && diff) {
          text += formatDiff(diff.patch, diff.files);
          await removeWorktree(wt.root, wt.path);
        }

        const summary = summarizeResult(result);
        const record = finish({
          status: jobStatus(result),
          iterations: result.iterationCount,
          ...summary,
          // In a worktree the diff is the authoritative list; "M\tpath" → "path"
          ...(diff && { files_changed: diff.files.map((f) => f.split("\t").pop()!) }),
          usage: toUsageRecord(result.usage),
          chars_returned: text.length,
        });
        if (result.usage) pool.recordUsage(w.id, result.usage);
        pendingWrites.push(
          writeJobRecord(config.jobLogDir, jobId, {
            result: record,
            transcript: result.messages,
            patch: diff?.patch,
          }),
        );
        return text;
      },
      { workerId: args.worker, signal: clientSignal },
    );
  } finally {
    await Promise.all(pendingWrites);
  }
}

const toolResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const toolError = (err: unknown) => ({
  content: [
    { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
  ],
  isError: true,
});

// Options shared by every job tool
const jobOptions = {
  worker: z
    .string()
    .optional()
    .describe(`Run on this worker id (${workerIds}). Omit to use the first free worker.`),
  model: z.string().optional().describe(`Model override (default: ${config.model})`),
  max_iterations: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Tool-call rounds allowed (default ${config.maxIterations})`),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Job wall-clock limit once it has a worker (default ${config.jobTimeoutMs / 1000}). On expiry the job stops and returns what it has.`,
    ),
};

const PARALLEL_NOTE =
  "Calls may be issued in parallel: each runs on its own worker and extra calls queue. Every result starts with a header naming the worker, job id, elapsed time and status.";

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "local-agent-mcp",
  version: "0.1.0",
});

server.registerTool(
  "local_analyze",
  {
    description: `Read-only repository investigation on a local worker: architecture discovery, affected files, dependency tracing, test discovery, failure diagnosis. Cannot modify files. Safe to run several in parallel. ${PARALLEL_NOTE}`,
    inputSchema: {
      objective: z.string().describe("The question to answer or the thing to find"),
      paths: z.array(z.string()).min(1).describe("Files or directories to inspect"),
      constraints: z.array(z.string()).optional().describe("Rules the worker must follow"),
      ...jobOptions,
    },
  },
  async (args, extra) => {
    try {
      return toolResult(
        await runJob(
          { ...args, tool: "local_analyze", prompt: analyzePrompt(args), mode: "analyze" },
          extra.signal,
        ),
      );
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "local_implement",
  {
    description: `Bounded implementation on a local worker inside an isolated git worktree seeded with your uncommitted changes. Returns a report, the list of changed files and a unified diff — apply it with \`git apply\`. Never touches your checkout. Safe to run several in parallel. ${PARALLEL_NOTE}`,
    inputSchema: {
      objective: z.string().describe("What to build or change"),
      paths: z
        .array(z.string())
        .min(1)
        .describe("Files or directories the worker may read and change"),
      acceptance_criteria: z
        .array(z.string())
        .min(1)
        .describe("Conditions that must all hold before the worker finishes"),
      test_commands: z
        .array(z.string())
        .describe("Commands the worker must run and report (may be empty)"),
      constraints: z.array(z.string()).optional().describe("Rules the worker must follow"),
      ...jobOptions,
    },
  },
  async (args, extra) => {
    try {
      return toolResult(
        await runJob(
          { ...args, tool: "local_implement", prompt: implementPrompt(args), mode: "implement" },
          extra.signal,
        ),
      );
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "local_review",
  {
    description: `Independent read-only review on a local worker of a diff and/or existing code: issues with severity and file:line, suggested fixes, test gaps, confidence. A cheap way to use a second worker while another implements. ${PARALLEL_NOTE}`,
    inputSchema: {
      objective: z.string().describe("What the review should establish"),
      paths: z.array(z.string()).optional().describe("Files or directories to inspect"),
      diff: z.string().optional().describe("A unified diff to review"),
      review_focus: z
        .array(z.string())
        .optional()
        .describe("Aspects to concentrate on, e.g. correctness, security, tests"),
      ...jobOptions,
    },
  },
  async (args, extra) => {
    if (!args.diff && !args.paths?.length) {
      return toolError(new Error("local_review needs a diff, paths, or both"));
    }
    try {
      return toolResult(
        await runJob(
          { ...args, tool: "local_review", prompt: reviewPrompt(args), mode: "analyze" },
          extra.signal,
        ),
      );
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "run_local_agent",
  {
    description: `Free-form task on a local model for anything local_analyze / local_implement / local_review do not fit. The agent can read, edit (replace_text), and write files, list directories, and run shell commands. Parallel analyze/implement calls are safe; do not run two direct calls that modify files at the same time. ${PARALLEL_NOTE}`,
    inputSchema: {
      prompt: z.string().describe("The task or question for the local agent"),
      mode: z
        .enum(["analyze", "implement", "direct"])
        .optional()
        .describe(
          "analyze: read-only against the checkout. implement: edits in an isolated git worktree seeded with your uncommitted changes; returns a diff and never touches the checkout. direct (default): edits the checkout in place.",
        ),
      ...jobOptions,
    },
  },
  async ({ mode = "direct", ...args }, extra) => {
    try {
      return toolResult(await runJob({ ...args, tool: "run_local_agent", mode }, extra.signal));
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "local_cancel",
  {
    description:
      "Stop a running job by its id (from a result header or local_worker_status). The job's tool call then returns with status cancelled and whatever it had done so far. Queued jobs have no id yet; cancel those from the client side.",
    inputSchema: { job_id: z.string() },
  },
  async ({ job_id }) => {
    const hit = pool.cancel(job_id);
    return toolResult(
      hit
        ? `cancelling job ${job_id} on worker ${hit.workerId} -- its result will arrive with status cancelled`
        : `no running job ${job_id} (queued jobs have no id yet; running ids appear in local_worker_status)`,
    );
  },
);

server.registerTool(
  "local_worker_status",
  {
    description:
      "Show each local worker's state (idle, busy, probing, unhealthy), provider, model, running job id, and totals (jobs, busy seconds, tokens); how many jobs are queued; and server-lifetime metrics including supervisor_context_saved_chars. Workers that are not busy are probed live.",
    inputSchema: {},
  },
  async () =>
    toolResult(JSON.stringify({ ...(await pool.status()), metrics: metrics.snapshot() }, null, 2)),
);

server.registerTool(
  "local_job_log",
  {
    description:
      "Read a finished job's stored record: request, result summary (status, tokens, files, commands) and the last N transcript entries with unclipped tool output. Use it when a result header shows a status other than completed.",
    inputSchema: {
      job_id: z.string().regex(/^[0-9a-f]{8}$/, "job ids are 8 hex characters"),
      tail: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("Transcript entries to return from the end (default 20)"),
    },
  },
  async ({ job_id, tail }) => {
    const record = await readJobRecord(config.jobLogDir, job_id, tail ?? 20);
    return record
      ? toolResult(JSON.stringify(record, null, 2))
      : toolError(new Error(`no record for job ${job_id} under ${config.jobLogDir}`));
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `local-agent-mcp | dir: ${config.workingDir} | model: ${config.model} | shell: ${config.shellMode} | workers: ${config.workers.map((w) => `${w.id}=${w.host} (${w.provider})`).join(", ")} | ctx: ${config.numCtx ?? "default"} | job timeout: ${config.jobTimeoutMs / 1000}s | jobs: ${config.jobLogDir}`,
  );
  if (config.numCtx !== undefined && config.workers.some((w) => w.provider === "openai")) {
    console.error(
      "[config] AGENT_NUM_CTX applies to Ollama workers only; set the context size on OpenAI-compatible servers themselves",
    );
  }
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
