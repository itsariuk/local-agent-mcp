import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OllamaMessage } from "../ollama.js";
import type { ChatRequest, ChatResponse, InferenceProvider } from "../provider.js";
import { toOpenAIMessages } from "../provider.js";
import { runAgentLoop, formatAgentResult, formatDiff, jobStatus, LoopError } from "../loop.js";
import type { AgentResult } from "../loop.js";

// A fake provider: the loop must not care what is behind it
const chat = vi.fn<(request: ChatRequest, signal?: AbortSignal) => Promise<ChatResponse>>();
const provider: InferenceProvider = { kind: "ollama", chat, health: async () => true };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reply(message: Partial<OllamaMessage>): ChatResponse {
  return { message: { role: "assistant", content: "", ...message } };
}

const readCall = (file: string) =>
  reply({ tool_calls: [{ function: { name: "read_file", arguments: { path: file } } }] });

let tempDir: string;

function run(
  extra: {
    numCtx?: number;
    readOnly?: boolean;
    signal?: AbortSignal;
    shellMode?: "restricted" | "none";
    allowedCommands?: string[];
  } = {},
) {
  return runAgentLoop({
    prompt: "do the thing",
    model: "m",
    provider,
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
    expect(chat.mock.calls[1]![0].jsonOnly).toBe(true);
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

    const request = chat.mock.calls[0]![0];
    expect(request.tools!.map((t) => t.function.name)).toEqual(["read_file", "list_dir", "bash"]);
    expect(request.messages[0]!.content).toContain("read-only");
    expect(result.steps[0]!.result.output).toContain("read-only");
    await expect(fs.access(path.join(tempDir, "x.txt"))).rejects.toThrow();
  });

  it("keeps the steps and reports cancelled when aborted mid-run", async () => {
    const controller = new AbortController();
    chat.mockResolvedValueOnce(readCall("test.txt"));
    chat.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled by local_cancel"));
      throw new DOMException("aborted", "AbortError");
    });

    const result = await run({ signal: controller.signal });

    expect(result.steps).toHaveLength(1);
    expect(result.aborted).toBe("cancelled");
    expect(result.finalMessage).toBe("");
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[0]![1]).toBe(controller.signal);
  });

  it("reports cancelled, not parse_failed, when aborted during correction retries", async () => {
    const controller = new AbortController();
    chat.mockResolvedValueOnce(reply({ content: '{"name": "read_file", "parameters": {"path": ' }));
    chat.mockImplementation(async () => {
      controller.abort(new Error("cancelled by local_cancel"));
      throw new DOMException("aborted", "AbortError");
    });

    const result = await run({ signal: controller.signal });

    expect(result.aborted).toBe("cancelled");
    expect(result.parseFailure).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "does not run the rest of a tool batch after an abort",
    async () => {
      const controller = new AbortController();
      chat.mockResolvedValueOnce(
        reply({
          tool_calls: [
            { function: { name: "bash", arguments: { command: "sleep 5" } } },
            { function: { name: "write_file", arguments: { path: "late.txt", content: "x" } } },
          ],
        }),
      );
      setTimeout(() => controller.abort(), 100); // fires while the first tool is still sleeping

      const result = await run({
        signal: controller.signal,
        shellMode: "restricted",
        allowedCommands: ["sleep"],
      });

      expect(result.aborted).toBe("cancelled");
      expect(result.steps.map((s) => s.toolName)).toEqual(["bash"]);
      await expect(fs.access(path.join(tempDir, "late.txt"))).rejects.toThrow();
    },
  );

  it("does not call the model when the signal is already aborted", async () => {
    const result = await run({ signal: AbortSignal.abort() });
    expect(chat).not.toHaveBeenCalled();
    expect(result.aborted).toBe("cancelled");
  });

  it("reports timed_out for a TimeoutError reason", async () => {
    const signal = AbortSignal.timeout(50);
    chat.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new DOMException("t", "TimeoutError");
    });

    const result = await run({ signal });

    expect(result.aborted).toBe("timed_out");
  });

  it("sends no format on the main call and names the tool on results", async () => {
    chat.mockResolvedValueOnce(readCall("test.txt"));
    chat.mockResolvedValueOnce(reply({ content: "Done." }));

    await run();

    expect(chat.mock.calls[0]![0].jsonOnly).toBeUndefined();
    const toolMessage = chat.mock.calls[1]![0].messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ tool_name: "read_file", content: "hello world" });
  });

  it("attaches text-extracted tool calls to the assistant message in history", async () => {
    chat.mockResolvedValueOnce(
      reply({ content: '{"name":"read_file","parameters":{"path":"test.txt"}}' }),
    );
    chat.mockResolvedValueOnce(reply({ content: "Done." }));

    await run();

    const history = chat.mock.calls[1]![0].messages;
    const assistant = history.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls).toEqual([
      { function: { name: "read_file", arguments: { path: "test.txt" } } },
    ]);
    // and the OpenAI translation of that history is well-formed
    const wire = toOpenAIMessages(history);
    const wireAssistant = wire.find((m) => m.role === "assistant")!;
    const wireTool = wire.find((m) => m.role === "tool")!;
    expect(wireAssistant.tool_calls![0]!.id).toBe("call_0");
    expect(wireTool.tool_call_id).toBe("call_0");
  });

  it("sums token usage across calls and returns the transcript", async () => {
    chat.mockResolvedValueOnce({ ...readCall("test.txt"), usage: { promptTokens: 10, completionTokens: 5 } });
    chat.mockResolvedValueOnce({ ...reply({ content: "Done." }), usage: { promptTokens: 20, completionTokens: 7 } });

    const result = await run();

    expect(result.usage).toEqual({ promptTokens: 30, completionTokens: 12 });
    expect(result.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
  });

  it("leaves usage undefined when the backend reports none", async () => {
    chat.mockResolvedValueOnce(reply({ content: "Done." }));
    const result = await run();
    expect(result.usage).toBeUndefined();
    expect(formatAgentResult(result, 5)).not.toContain("tok");
  });

  it("keeps the partial transcript on the error when the backend fails mid-job", async () => {
    chat.mockResolvedValueOnce({ ...readCall("test.txt"), usage: { promptTokens: 5, completionTokens: 1 } });
    chat.mockRejectedValueOnce(new Error("Ollama error: 500 Internal Server Error"));

    const err = await run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LoopError);
    const { partial } = err as LoopError;
    expect((err as Error).message).toContain("500");
    expect(partial.steps).toHaveLength(1);
    expect(partial.iterationCount).toBe(2);
    expect(partial.usage).toEqual({ promptTokens: 5, completionTokens: 1 });
    expect(partial.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  });

  it("echoes the call id on the tool result when the backend gave one", async () => {
    chat.mockResolvedValueOnce(
      reply({
        tool_calls: [
          { id: "call_7", function: { name: "read_file", arguments: { path: "test.txt" } } },
        ],
      }),
    );
    chat.mockResolvedValueOnce(reply({ content: "Done." }));

    await run();

    const toolMessage = chat.mock.calls[1]![0].messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ tool_call_id: "call_7", tool_name: "read_file" });
  });

  it("forwards numCtx only when set", async () => {
    chat.mockResolvedValue(reply({ content: "Done." }));

    await run({ numCtx: 8192 });
    await run();

    expect(chat.mock.calls[0]![0].numCtx).toBe(8192);
    expect(chat.mock.calls[1]![0].numCtx).toBeUndefined();
  });

  it("clips large tool output for the model but keeps it in steps", async () => {
    await fs.writeFile(path.join(tempDir, "big.txt"), "x".repeat(50_000), "utf-8");
    chat.mockResolvedValueOnce(readCall("big.txt"));
    chat.mockResolvedValueOnce(reply({ content: "Done." }));

    const result = await run();

    const toolMessage = chat.mock.calls[1]![0].messages.find((m) => m.role === "tool")!;
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
    messages: [],
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
      "[worker gpu0 | m | job 3f2a1c9e | 17.8s | 3 iterations | mode direct | status completed]\nSummary.",
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

describe("jobStatus", () => {
  const base = {
    steps: [],
    finalMessage: "x",
    iterationCount: 1,
    stoppedByLimit: false,
    messages: [],
  };
  it("maps result shapes to statuses", () => {
    expect(jobStatus(base)).toBe("completed");
    expect(jobStatus({ ...base, stoppedByLimit: true })).toBe("stopped_at_limit");
    expect(
      jobStatus({
        ...base,
        parseFailure: { reason: "r", rawContent: "", attemptCount: 3, lastError: "r" },
      }),
    ).toBe("parse_failed");
    expect(jobStatus({ ...base, aborted: "cancelled" })).toBe("cancelled");
    expect(jobStatus({ ...base, aborted: "timed_out" })).toBe("timed_out");
  });

  it("shows in the header and as a log line, with a log hint when not completed", () => {
    const run = { workerId: "w", model: "m", jobId: "j", elapsedMs: 1000, mode: "direct" };
    const text = formatAgentResult({ ...base, finalMessage: "", aborted: "cancelled" }, 20, run);
    expect(text).toContain("| status cancelled]");
    expect(text).toContain("[cancelled after 1 iterations");
    expect(text).toContain('[full log: local_job_log("j")]');
    expect(text).not.toContain("empty final message");
    expect(formatAgentResult(base, 20, run)).not.toContain("local_job_log");
  });

  it("puts token usage in the header", () => {
    const run = { workerId: "w", model: "m", jobId: "j", elapsedMs: 1000, mode: "direct" };
    const usage = { promptTokens: 18_400, completionTokens: 1_200 };
    expect(formatAgentResult({ ...base, usage }, 20, run)).toContain(
      "| 1 iterations | 18.4k→1.2k tok | mode direct |",
    );
    expect(formatAgentResult({ ...base, usage: { promptTokens: 30, completionTokens: 12 } }, 20, run)).toContain(
      "| 30→12 tok |",
    );
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
