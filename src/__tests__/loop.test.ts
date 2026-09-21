import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chatWithOllama } from "../ollama.js";
import type { OllamaChatResponse, OllamaMessage } from "../ollama.js";
import { runAgentLoop, formatAgentResult, formatDiff } from "../loop.js";
import type { AgentResult } from "../loop.js";

vi.mock("../ollama.js", () => ({ chatWithOllama: vi.fn() }));
const chat = vi.mocked(chatWithOllama);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reply(message: Partial<OllamaMessage>): OllamaChatResponse {
  return { message: { role: "assistant", content: "", ...message }, done: true };
}

const readCall = (file: string) =>
  reply({ tool_calls: [{ function: { name: "read_file", arguments: { path: file } } }] });

let tempDir: string;

function run(extra: { numCtx?: number; readOnly?: boolean } = {}) {
  return runAgentLoop({
    prompt: "do the thing",
    model: "m",
    host: "http://x",
    workingDir: tempDir,
    maxIterations: 5,
    shellMode: "none",
    allowedCommands: [],
    timeoutMs: 5000,
    ...extra,
  });
}

beforeEach(async () => {
  chat.mockReset();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-test-"));
  await fs.writeFile(path.join(tempDir, "test.txt"), "hello world", "utf-8");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Termination and tool-call tiers
// ---------------------------------------------------------------------------

describe("runAgentLoop", () => {
  it("ends the job on a prose answer without retrying", async () => {
    chat.mockResolvedValueOnce(readCall("test.txt"));
    chat.mockResolvedValueOnce(reply({ content: "All done." }));

    const result = await run();

    expect(result.finalMessage).toBe("All done.");
    expect(result.parseFailure).toBeUndefined();
    expect(result.steps).toHaveLength(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("still executes a tool call embedded in prose", async () => {
    chat.mockResolvedValueOnce(
      reply({ content: 'I\'ll read it: {"name":"read_file","parameters":{"path":"test.txt"}}' }),
    );
    chat.mockResolvedValueOnce(reply({ content: "Read it." }));

    const result = await run();

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.toolName).toBe("read_file");
    expect(result.finalMessage).toBe("Read it.");
  });

  it("retries a broken tool-call attempt through the correction prompt", async () => {
    chat.mockResolvedValueOnce(reply({ content: '{"name": "read_file", "parameters": {"path": ' }));
    chat.mockResolvedValueOnce(
      reply({ content: '{"name":"read_file","parameters":{"path":"test.txt"}}' }),
    );
    chat.mockResolvedValueOnce(reply({ content: "Recovered." }));

    const result = await run();

    expect(result.steps).toHaveLength(1);
    expect(result.finalMessage).toBe("Recovered.");
    expect(chat).toHaveBeenCalledTimes(3);
    // Only the correction call asks for bare JSON
    expect(chat.mock.calls[1]![1].format).toBe("json");
  });

  it("does not re-run a tool call quoted inside the final report", async () => {
    chat.mockResolvedValueOnce(
      reply({
        content: 'Ran {"name":"read_file","parameters":{"path":"test.txt"}} and it worked.',
      }),
    );

    const result = await run();

    expect(result.steps).toHaveLength(0);
    expect(result.finalMessage).toContain("and it worked.");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("does not retry a final answer that opens with a code fence", async () => {
    chat.mockResolvedValueOnce(reply({ content: "```diff\n- a\n+ b\n```\nApplied." }));

    const result = await run();

    expect(result.parseFailure).toBeUndefined();
    expect(result.finalMessage).toContain("Applied.");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("retries a truncated attempt that follows a prose preamble", async () => {
    chat.mockResolvedValueOnce(
      reply({ content: 'Reading first:\n{"name":"read_file","parameters":{"path": ' }),
    );
    chat.mockResolvedValueOnce(
      reply({ content: '{"name":"read_file","parameters":{"path":"test.txt"}}' }),
    );
    chat.mockResolvedValueOnce(reply({ content: "Recovered." }));

    const result = await run();

    expect(result.steps).toHaveLength(1);
    expect(result.finalMessage).toBe("Recovered.");
  });

  it("in read-only mode offers no write tools, uses the analyst prompt, and refuses writes", async () => {
    chat.mockResolvedValueOnce(
      reply({
        tool_calls: [
          { function: { name: "write_file", arguments: { path: "x.txt", content: "x" } } },
        ],
      }),
    );
    chat.mockResolvedValueOnce(reply({ content: "Done." }));

    const result = await run({ readOnly: true });

    const request = chat.mock.calls[0]![1];
    expect(request.tools!.map((t) => t.function.name)).toEqual(["read_file", "list_dir", "bash"]);
    expect(request.messages[0]!.content).toContain("read-only");
    expect(result.steps[0]!.result.output).toContain("read-only");
    await expect(fs.access(path.join(tempDir, "x.txt"))).rejects.toThrow();
  });

  it("sends no format on the main call and names the tool on results", async () => {
    chat.mockResolvedValueOnce(readCall("test.txt"));
    chat.mockResolvedValueOnce(reply({ content: "Done." }));

    await run();

    expect(chat.mock.calls[0]![1].format).toBeUndefined();
    const toolMessage = chat.mock.calls[1]![1].messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ tool_name: "read_file", content: "hello world" });
  });

  it("forwards numCtx as options.num_ctx only when set", async () => {
    chat.mockResolvedValue(reply({ content: "Done." }));

    await run({ numCtx: 8192 });
    await run();

    expect(chat.mock.calls[0]![1].options).toEqual({ num_ctx: 8192 });
    expect(chat.mock.calls[1]![1].options).toBeUndefined();
  });

  it("clips large tool output for the model but keeps it in steps", async () => {
    await fs.writeFile(path.join(tempDir, "big.txt"), "x".repeat(50_000), "utf-8");
    chat.mockResolvedValueOnce(readCall("big.txt"));
    chat.mockResolvedValueOnce(reply({ content: "Done." }));

    const result = await run();

    const toolMessage = chat.mock.calls[1]![1].messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content.length).toBeLessThan(16_100);
    expect(toolMessage.content).toContain("[... clipped");
    expect(result.steps[0]!.result.output).toHaveLength(50_000);
  });
});

// ---------------------------------------------------------------------------
// Supervisor-facing report
// ---------------------------------------------------------------------------

describe("formatAgentResult", () => {
  const base: AgentResult = {
    steps: [],
    finalMessage: "Summary.",
    iterationCount: 1,
    stoppedByLimit: false,
  };

  it("clips failure output to its tail", () => {
    const output = "x".repeat(5000) + "AssertionError: the end";
    const text = formatAgentResult(
      {
        ...base,
        steps: [
          { toolName: "bash", args: { command: "npm test" }, result: { success: false, output } },
        ],
      },
      20,
    );
    const stepLine = text.split("\n")[0]!;
    expect(stepLine.length).toBeLessThan(700);
    expect(stepLine).toContain("AssertionError: the end");
    expect(text).toContain("Summary.");
  });

  it("prepends a run header only when run info is given", () => {
    const run = {
      workerId: "gpu0",
      model: "m",
      jobId: "3f2a1c9e",
      elapsedMs: 17_840,
      mode: "direct",
    };
    expect(formatAgentResult({ ...base, iterationCount: 3 }, 20, run)).toBe(
      "[worker gpu0 | m | job 3f2a1c9e | 17.8s | 3 iterations | mode direct]\nSummary.",
    );
    expect(formatAgentResult(base, 20)).toBe("Summary.");
  });

  it("reports the iteration limit", () => {
    const text = formatAgentResult({ ...base, finalMessage: "", stoppedByLimit: true }, 20);
    expect(text).toContain("max iterations reached (20)");
  });

  it("flags an empty final message", () => {
    const text = formatAgentResult({ ...base, finalMessage: "" }, 20);
    expect(text).toContain("empty final message");
  });

  it("includes clipped raw content on parse failure", () => {
    const text = formatAgentResult(
      {
        ...base,
        finalMessage: "",
        parseFailure: {
          reason: "bad json",
          rawContent: "y".repeat(5000),
          attemptCount: 3,
          lastError: "bad json",
        },
      },
      20,
    );
    expect(text).toContain("parse failed after 3 attempts: bad json");
    expect(text.length).toBeLessThan(700);
  });
});

describe("formatDiff", () => {
  it("lists files then the patch", () => {
    expect(formatDiff("diff --git a/x b/x\n+1\n", ["M\tx"])).toBe(
      "\n\n--- changes (1 files) ---\nM\tx\n\ndiff --git a/x b/x\n+1\n",
    );
  });

  it("says so when nothing changed", () => {
    expect(formatDiff("", [])).toBe("\n\n[no files changed]");
  });

  it("clips a huge patch", () => {
    const text = formatDiff("x".repeat(300_000), ["M\tx"]);
    expect(text.length).toBeLessThan(201_000);
    expect(text).toContain("[diff truncated: 100000 more chars");
  });
});
