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
// MCP Server
// ---------------------------------------------------------------------------

const pool = new WorkerPool(config.workers);
const workerIds = config.workers.map((w) => w.id).join(", ");

const server = new McpServer({
  name: "local-agent-mcp",
  version: "0.1.0",
});

server.registerTool(
  "run_local_agent",
  {
    description:
      "Run a bounded coding task on a local model. The agent can read, edit (replace_text), and write files, list directories, and run shell commands, and returns a concise report. Calls may be issued in parallel: each runs on its own worker and extra calls queue. Parallel analyze/implement calls are safe; do not run two direct calls that modify files at the same time.",
    inputSchema: {
      prompt: z.string().describe("The task or question for the local agent"),
      model: z.string().optional().describe(`Ollama model name (default: ${config.model})`),
      worker: z
        .string()
        .optional()
        .describe(`Run on this worker id (${workerIds}). Omit to use the first free worker.`),
      mode: z
        .enum(["analyze", "implement", "direct"])
        .optional()
        .describe(
          "analyze: read-only against the checkout. implement: edits in an isolated git worktree seeded with your uncommitted changes; returns a diff and never touches the checkout. direct (default): edits the checkout in place.",
        ),
    },
  },
  async ({ prompt, model, worker, mode = "direct" }, extra) => {
    try {
      const started = Date.now();
      const responseText = await pool.run(
        async (w, jobId) => {
          const wt =
            mode === "implement" ? await createWorktree(config.workingDir, jobId) : undefined;
          let result: AgentResult;
          let diff: { patch: string; files: string[] } | undefined;
          try {
            result = await runAgentLoop({
              prompt,
              model: model ?? w.model,
              host: w.host,
              workingDir: wt ? path.join(wt.path, wt.relativeDir) : config.workingDir,
              maxIterations: config.maxIterations,
              shellMode: config.shellMode,
              allowedCommands: config.allowedCommands,
              timeoutMs: config.timeoutMs,
              numCtx: config.numCtx,
              readOnly: mode === "analyze",
            });
            if (wt) diff = await captureDiff(wt.path);
          } catch (err) {
            // Keep the worktree for inspection and say where it is
            const message = err instanceof Error ? err.message : String(err);
            throw wt ? new Error(`${message} (worktree kept at ${wt.path})`, { cause: err }) : err;
          }
          let text = formatAgentResult(result, config.maxIterations, {
            workerId: w.id,
            model: model ?? w.model,
            jobId,
            elapsedMs: Date.now() - started,
            mode,
          });
          if (wt && diff) {
            text += formatDiff(diff.patch, diff.files);
            await removeWorktree(wt.root, wt.path);
          }
          return text;
        },
        { workerId: worker, signal: extra.signal },
      );

      return {
        content: [{ type: "text" as const, text: responseText }],
      };
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
  },
);

server.registerTool(
  "local_worker_status",
  {
    description:
      "Show each local worker's state (idle, busy, probing, unhealthy), its model, the running job id, and how many jobs are queued. Workers that are not busy are probed live.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(await pool.status(), null, 2) }],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `local-agent-mcp | dir: ${config.workingDir} | model: ${config.model} | shell: ${config.shellMode} | workers: ${config.workers.map((w) => `${w.id}=${w.host}`).join(", ")} | ctx: ${config.numCtx ?? "default"}`,
  );
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
