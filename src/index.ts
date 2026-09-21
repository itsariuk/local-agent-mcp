import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgentLoop, formatAgentResult } from "./loop.js";
import { loadConfig, ConfigError } from "./config.js";
import type { AppConfig } from "./config.js";

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

const server = new McpServer({
  name: "local-agent-mcp",
  version: "0.1.0",
});

server.registerTool(
  "run_local_agent",
  {
    description:
      "Run a bounded coding task on a local model. The agent can read, edit (replace_text), and write files, list directories, and run shell commands, and returns a concise report.",
    inputSchema: {
      prompt: z.string().describe("The task or question for the local agent"),
      model: z.string().optional().describe(`Ollama model name (default: ${config.model})`),
    },
  },
  async ({ prompt, model }) => {
    try {
      const result = await runAgentLoop({
        prompt,
        model: model ?? config.model,
        host: config.ollamaHost,
        workingDir: config.workingDir,
        maxIterations: config.maxIterations,
        shellMode: config.shellMode,
        allowedCommands: config.allowedCommands,
        timeoutMs: config.timeoutMs,
        numCtx: config.numCtx,
      });

      const responseText = formatAgentResult(result, config.maxIterations);

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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `local-agent-mcp | dir: ${config.workingDir} | model: ${config.model} | shell: ${config.shellMode} | host: ${config.ollamaHost} | ctx: ${config.numCtx ?? "default"}`,
  );
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
