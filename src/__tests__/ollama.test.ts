import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkHealth, chatWithOllama, OllamaProvider } from "../ollama.js";

// ---------------------------------------------------------------------------
// Mock server helper
// ---------------------------------------------------------------------------

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("chatWithOllama", () => {
  it("passes an abort through as the signal's reason, not as 'not running'", async () => {
    const url = await listen(() => {}); // never answers
    const request = { model: "m", messages: [], stream: false as const };
    await expect(chatWithOllama(url, request, AbortSignal.timeout(100))).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});

describe("OllamaProvider", () => {
  it("maps jsonOnly/numCtx onto the request and token counts onto usage", async () => {
    let body: Record<string, unknown> = {};
    const url = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        body = JSON.parse(raw);
        res.end(
          JSON.stringify({
            message: { role: "assistant", content: "ok" },
            done: true,
            prompt_eval_count: 7,
            eval_count: 3,
          }),
        );
      });
    });

    const result = await new OllamaProvider(url).chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      jsonOnly: true,
      numCtx: 2048,
    });

    expect(body).toMatchObject({ model: "m", format: "json", options: { num_ctx: 2048 } });
    expect(result).toEqual({
      message: { role: "assistant", content: "ok" },
      usage: { promptTokens: 7, completionTokens: 3 },
    });
    expect(new OllamaProvider(url).kind).toBe("ollama");
  });
});

describe("checkHealth", () => {
  it("is true when /api/version answers 200", async () => {
    const url = await listen((req, res) => {
      res.statusCode = req.url === "/api/version" ? 200 : 404;
      res.end('{"version":"mock"}');
    });
    expect(await checkHealth(url)).toBe(true);
  });

  it("is false on a 500", async () => {
    const url = await listen((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    expect(await checkHealth(url)).toBe(false);
  });

  it("is false when nothing listens on the port", async () => {
    const url = await listen(() => {});
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await checkHealth(url)).toBe(false);
  });

  it("is false when the server never answers", async () => {
    const url = await listen(() => {});
    expect(await checkHealth(url, 200)).toBe(false);
  });
});
