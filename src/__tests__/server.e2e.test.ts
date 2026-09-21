// End-to-end: the real MCP server over stdio, against mock Ollama servers.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CHAT_DELAY_MS = 300;
const execFile = promisify(execFileCb);
const git = (cwd: string, ...args: string[]) =>
  execFile("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd }).then(
    (r) => r.stdout,
  );

// A prompt starting with "write:" makes the mock issue one write_file call, then finish.
const WRITE_CALL = {
  tool_calls: [
    { function: { name: "write_file", arguments: { path: "worker.txt", content: "w\n" } } },
  ],
};

// ---------------------------------------------------------------------------
// Mock Ollama
// ---------------------------------------------------------------------------

interface MockOllama {
  url: string;
  server: http.Server;
  chats: number;
  maxInFlight: number;
}

async function startMockOllama(): Promise<MockOllama> {
  let inFlight = 0;
  const mock: MockOllama = { url: "", chats: 0, maxInFlight: 0, server: http.createServer() };

  mock.server.on("request", (req, res) => {
    if (req.url === "/api/version") {
      res.end('{"version":"mock"}');
      return;
    }
    mock.chats++;
    inFlight++;
    mock.maxInFlight = Math.max(mock.maxInFlight, inFlight);
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const { messages } = JSON.parse(body) as {
        messages: Array<{ role: string; content: string }>;
      };
      const wantsWrite =
        messages[1]!.content.startsWith("write:") && !messages.some((m) => m.role === "tool");
      setTimeout(() => {
        inFlight--;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            message: {
              role: "assistant",
              content: wantsWrite ? "" : "done",
              ...(wantsWrite && WRITE_CALL),
            },
            done: true,
          }),
        );
      }, CHAT_DELAY_MS);
    });
  });

  await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`;
  return mock;
}

function stopMock(mock: MockOllama): Promise<void> {
  mock.server.closeAllConnections();
  return new Promise((resolve) => mock.server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client over stdio
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let child: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();

function request<T>(method: string, params: object = {}): Promise<T> {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise<T>((resolve) => pending.set(id, resolve as (result: unknown) => void));
}

const callTool = (name: string, args: object = {}) =>
  request<ToolResult>("tools/call", { name, arguments: args });

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let gpu0: MockOllama;
let gpu1: MockOllama;
let tempDir: string;

beforeAll(async () => {
  [gpu0, gpu1] = await Promise.all([startMockOllama(), startMockOllama()]);
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-test-"));
  await git(tempDir, "init", "-q");
  await fs.writeFile(path.join(tempDir, "a.txt"), "a\n");
  await git(tempDir, "add", "-A");
  await git(tempDir, "commit", "-qm", "base");
  await fs.writeFile(path.join(tempDir, "u.txt"), "uncommitted\n"); // dirty on purpose

  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: {
      ...process.env,
      AGENT_WORKERS: `gpu0=${gpu0.url},gpu1=${gpu1.url}`,
      AGENT_MODEL: "m",
      AGENT_WORKING_DIR: tempDir,
    },
  });

  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line) as { id?: number; result?: unknown };
      if (message.id !== undefined) {
        pending.get(message.id)?.(message.result);
        pending.delete(message.id);
      }
    }
  });

  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}, 20_000);

afterAll(async () => {
  child.kill();
  await Promise.all([stopMock(gpu0), stopMock(gpu1)]);
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests (order matters: the last one takes gpu1 down)
// ---------------------------------------------------------------------------

describe("MCP server with two workers", { timeout: 20_000 }, () => {
  it("lists both tools", async () => {
    const { tools } = await request<{ tools: Array<{ name: string }> }>("tools/list");
    expect(tools.map((t) => t.name).sort()).toEqual(["local_worker_status", "run_local_agent"]);
  });

  it("runs two of three concurrent calls in parallel and queues the third", async () => {
    const started = Date.now();
    const results = await Promise.all([
      callTool("run_local_agent", { prompt: "a" }),
      callTool("run_local_agent", { prompt: "b" }),
      callTool("run_local_agent", { prompt: "c" }),
    ]);
    const elapsed = Date.now() - started;

    expect(results.every((r) => !r.isError)).toBe(true);
    // One job per worker at a time, and both workers were used
    expect(gpu0.maxInFlight).toBe(1);
    expect(gpu1.maxInFlight).toBe(1);
    expect(gpu0.chats + gpu1.chats).toBe(3);
    const headers = results.map((r) => r.content[0]!.text.split("\n")[0]!);
    expect(headers.some((h) => h.startsWith("[worker gpu0 "))).toBe(true);
    expect(headers.some((h) => h.startsWith("[worker gpu1 "))).toBe(true);
    // Two rounds of chat, not one (unbounded) and not three (serialised)
    expect(elapsed).toBeGreaterThanOrEqual(2 * CHAT_DELAY_MS - 50);
    expect(elapsed).toBeLessThan(3 * CHAT_DELAY_MS + 400);
  });

  it("rejects an unknown worker id", async () => {
    const result = await callTool("run_local_agent", { prompt: "a", worker: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unknown worker: nope");
  });

  it("honours an explicit worker id", async () => {
    const result = await callTool("run_local_agent", { prompt: "a", worker: "gpu1" });
    expect(result.content[0]!.text).toMatch(/^\[worker gpu1 /);
  });

  it("implement mode returns a diff and leaves the checkout untouched", async () => {
    const result = await callTool("run_local_agent", { prompt: "write: x", mode: "implement" });
    const text = result.content[0]!.text;

    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/^\[worker gpu\d .*\| mode implement\]/);
    expect(text).toContain("--- changes (1 files) ---\nA\tworker.txt");
    expect(text).toContain("+w");
    await expect(fs.access(path.join(tempDir, "worker.txt"))).rejects.toThrow();
    expect(await git(tempDir, "status", "--porcelain")).toBe("?? u.txt\n");
    expect((await git(tempDir, "worktree", "list")).trim().split("\n")).toHaveLength(1);
  });

  it("analyze mode refuses the write", async () => {
    const result = await callTool("run_local_agent", { prompt: "write: x", mode: "analyze" });
    expect(result.content[0]!.text).toContain("write_file is not available in read-only mode");
    await expect(fs.access(path.join(tempDir, "worker.txt"))).rejects.toThrow();
  });

  it("direct mode (default) edits the checkout in place", async () => {
    const result = await callTool("run_local_agent", { prompt: "write: x" });
    expect(result.content[0]!.text).toContain("| mode direct]");
    expect(await fs.readFile(path.join(tempDir, "worker.txt"), "utf-8")).toBe("w\n");
    await fs.rm(path.join(tempDir, "worker.txt"));
  });

  it("reports a dead worker and keeps working on the live one", async () => {
    const before = JSON.parse((await callTool("local_worker_status")).content[0]!.text);
    expect(before).toEqual({
      workers: [
        { id: "gpu0", status: "idle", model: "m" },
        { id: "gpu1", status: "idle", model: "m" },
      ],
      queued: 0,
    });

    await stopMock(gpu1);

    const after = JSON.parse((await callTool("local_worker_status")).content[0]!.text);
    expect(after.workers[1]).toEqual({ id: "gpu1", status: "unhealthy", model: "m" });

    const result = await callTool("run_local_agent", { prompt: "a" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toMatch(/^\[worker gpu0 /);
  });
});
