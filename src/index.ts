import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgentLoop, formatAgentResult } from "./loop.js";
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
      "Run a bounded coding task on a local model. The agent can read, edit (replace_text), and write files, list directories, and run shell commands, and returns a concise report. Calls may be issued in parallel: each runs on its own worker and extra calls queue. Do not run two file-modifying tasks in parallel on the same checkout.",
    inputSchema: {
      prompt: z.string().describe("The task or question for the local agent"),
      model: z.string().optional().describe(`Ollama model name (default: ${config.model})`),
      worker: z
        .string()
        .optional()
        .describe(`Run on this worker id (${workerIds}). Omit to use the first free worker.`),
    },
  },
  async ({ prompt, model, worker }, extra) => {
    try {
      const started = Date.now();
      const responseText = await pool.run(
        async (w, jobId) => {
          const result = await runAgentLoop({
            prompt,
            model: model ?? w.model,
            host: w.host,
            workingDir: config.workingDir,
            maxIterations: config.maxIterations,
            shellMode: config.shellMode,
            allowedCommands: config.allowedCommands,
            timeoutMs: config.timeoutMs,
            numCtx: config.numCtx,
          });
          return formatAgentResult(result, config.maxIterations, {
            workerId: w.id,
            model: model ?? w.model,
            jobId,
            elapsedMs: Date.now() - started,
          });
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
