import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJobRecord, readJobRecord, summarizeResult, toUsageRecord, Metrics } from "../jobs.js";
import type { JobRequestRecord, JobResultRecord } from "../jobs.js";
import type { AgentResult } from "../loop.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jobs-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const request: JobRequestRecord = {
  job_id: "0a1b2c3d",
  tool: "local_analyze",
  mode: "analyze",
  prompt: "p",
  worker: "gpu0",
  provider: "ollama",
  model: "m",
  max_iterations: 20,
  timeout_seconds: 900,
  started_at: "2026-09-21T00:00:00.000Z",
};

const result: JobResultRecord = {
  job_id: "0a1b2c3d",
  status: "completed",
  iterations: 3,
  elapsed_ms: 1234,
  usage: { prompt_tokens: 100, completion_tokens: 20 },
  tool_calls: 2,
  files_read: ["a.ts"],
  files_changed: [],
  commands_run: [{ command: "ls", success: true }],
  chars_consumed: 500,
  chars_returned: 120,
  finished_at: "2026-09-21T00:00:01.000Z",
};

describe("writeJobRecord / readJobRecord", () => {
  it("round-trips request, result, transcript and patch", async () => {
    const transcript = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ];
    await writeJobRecord(dir, "0a1b2c3d", {
      request,
      result,
      transcript,
      patch: "diff --git a b\n",
    });

    const files = (await fs.readdir(path.join(dir, "0a1b2c3d"))).sort();
    expect(files).toEqual(["patch.diff", "request.json", "result.json", "transcript.jsonl"]);
    expect(await readJobRecord(dir, "0a1b2c3d")).toEqual({ request, result, transcript });
  });

  it("writes no patch file for an empty patch and limits the transcript tail", async () => {
    const transcript = Array.from({ length: 30 }, (_, i) => ({ i }));
    await writeJobRecord(dir, "0a1b2c3d", { result, transcript, patch: "" });

    expect(await fs.readdir(path.join(dir, "0a1b2c3d"))).not.toContain("patch.diff");
    const record = await readJobRecord(dir, "0a1b2c3d", 5);
    expect(record!.transcript).toEqual([{ i: 25 }, { i: 26 }, { i: 27 }, { i: 28 }, { i: 29 }]);
    expect(record!.request).toBeUndefined();
  });

  it("returns undefined for a missing or malformed id without touching the filesystem", async () => {
    expect(await readJobRecord(dir, "ffffffff")).toBeUndefined();
    expect(await readJobRecord(dir, "../etc")).toBeUndefined();
    await writeJobRecord(dir, "../escape", { request });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("never throws when the directory is unwritable", async () => {
    await fs.chmod(dir, 0o500);
    await expect(writeJobRecord(dir, "0a1b2c3d", { request })).resolves.toBeUndefined();
    await fs.chmod(dir, 0o700);
  });
});

describe("summarizeResult", () => {
  it("derives files, commands and consumed characters from the steps and transcript", () => {
    const agent: AgentResult = {
      steps: [
        {
          toolName: "read_file",
          args: { path: "a.ts" },
          result: { success: true, output: "x".repeat(100) },
        },
        {
          toolName: "read_file",
          args: { path: "a.ts" },
          result: { success: true, output: "x".repeat(100) },
        },
        {
          toolName: "replace_text",
          args: { path: "a.ts", old_text: "1", new_text: "2" },
          result: { success: true, output: "ok" },
        },
        {
          toolName: "write_file",
          args: { path: "b.ts", content: "" },
          result: { success: false, output: "read-only" },
        },
        {
          toolName: "bash",
          args: { command: "npm test" },
          result: { success: false, output: "fail" },
        },
      ],
      finalMessage: "done",
      iterationCount: 3,
      stoppedByLimit: false,
      messages: [
        { role: "system", content: "s" },
        { role: "assistant", content: "thinking" },
      ],
    };
    expect(summarizeResult(agent)).toEqual({
      tool_calls: 5,
      files_read: ["a.ts"],
      files_changed: ["a.ts"],
      commands_run: [{ command: "npm test", success: false }],
      chars_consumed: 100 + 100 + 2 + 9 + 4 + "thinking".length,
    });
  });

  it("maps usage to snake_case or undefined", () => {
    expect(toUsageRecord({ promptTokens: 1, completionTokens: 2 })).toEqual({
      prompt_tokens: 1,
      completion_tokens: 2,
    });
    expect(toUsageRecord(undefined)).toBeUndefined();
  });
});

describe("Metrics", () => {
  it("counts jobs by status and sums tokens, tool calls and characters", () => {
    const m = new Metrics();
    m.started();
    m.started();
    m.finished({ ...result, status: "completed" });
    m.finished({ ...result, status: "cancelled", usage: undefined, chars_returned: 700 });

    const snap = m.snapshot();
    expect(snap.jobs).toEqual({ started: 2, completed: 1, cancelled: 1 });
    expect(snap.tokens).toEqual({ prompt: 100, completion: 20 });
    expect(snap.tool_calls).toBe(4);
    expect(snap.chars_consumed).toBe(1000);
    expect(snap.chars_returned).toBe(820);
    expect(snap.supervisor_context_saved_chars).toBe(180);
    expect(snap.since).toMatch(/^\d{4}-/);
  });

  it("never reports negative savings", () => {
    const m = new Metrics();
    m.finished({ ...result, chars_consumed: 10, chars_returned: 50 });
    expect(m.snapshot().supervisor_context_saved_chars).toBe(0);
  });
});
