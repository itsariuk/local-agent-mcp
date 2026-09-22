import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAIProvider, createProvider, toOpenAIMessages } from "../provider.js";
import type { ChatMessage } from "../provider.js";

// ---------------------------------------------------------------------------
// Mock server helper (captures the last request)
// ---------------------------------------------------------------------------

const servers: http.Server[] = [];

interface Captured {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

async function listen(
  reply: (req: Captured) => { status?: number; json?: unknown } | undefined,
): Promise<{ url: string; last: () => Captured }> {
  let last: Captured | undefined;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      last = {
        url: req.url!,
        method: req.method!,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      const r = reply(last);
      if (!r) return; // never answer
      res.statusCode = r.status ?? 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    last: () => last!,
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

const done = { choices: [{ message: { role: "assistant", content: "done" } }] };
const tools = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "d",
      parameters: { type: "object" as const, properties: {}, required: [] },
    },
  },
];

// ---------------------------------------------------------------------------
// Outbound translation
// ---------------------------------------------------------------------------

describe("toOpenAIMessages", () => {
  it("stringifies tool arguments and echoes tool_call_id, dropping tool_name", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: { path: "a" } } }],
      },
      { role: "tool", tool_call_id: "call_1", tool_name: "read_file", content: "x" },
    ];
    expect(toOpenAIMessages(history)).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: "tool", content: "x", tool_call_id: "call_1" },
    ]);
  });

  it("invents ids for text-extracted calls and points the following tool messages at them", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "a" } } },
          { function: { name: "list_dir", arguments: { path: "." } } },
        ],
      },
      { role: "tool", tool_name: "read_file", content: "x" },
      { role: "tool", tool_name: "list_dir", content: "y" },
    ];
    const out = toOpenAIMessages(history);
    expect(out[0]!.tool_calls!.map((c) => c.id)).toEqual(["call_0", "call_1"]);
    expect(out[1]!.tool_call_id).toBe("call_0");
    expect(out[2]!.tool_call_id).toBe("call_1");
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider
// ---------------------------------------------------------------------------

describe("OpenAIProvider.chat", () => {
  it("posts the translated request and maps the response back", async () => {
    const { url, last } = await listen(() => ({
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              reasoning: "thinking...",
              tool_calls: [
                {
                  id: "call_9",
                  type: "function",
                  function: { name: "bash", arguments: '{"command":"ls"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    }));

    const result = await new OpenAIProvider(url).chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools,
      jsonOnly: true,
      numCtx: 4096,
    });

    const req = last();
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.body).toEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      tools,
      response_format: { type: "json_object" },
    });
    expect(req.headers.authorization).toBeUndefined();
    expect(result).toEqual({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_9", function: { name: "bash", arguments: { command: "ls" } } }],
      },
      usage: { promptTokens: 10, completionTokens: 5 },
    });
  });

  it("omits an empty tools array and the response_format when not jsonOnly", async () => {
    const { url, last } = await listen(() => ({ json: done }));
    await new OpenAIProvider(url).chat({ model: "m", messages: [], tools: [] });
    expect(last().body).toEqual({ model: "m", messages: [], stream: false });
  });

  it("tolerates unparseable and object-form arguments", async () => {
    const { url } = await listen(() => ({
      json: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "a", function: { name: "bash", arguments: "{not json" } },
                { id: "b", function: { name: "bash", arguments: { command: "ls" } } },
              ],
            },
          },
        ],
      },
    }));
    const { message } = await new OpenAIProvider(url).chat({ model: "m", messages: [], tools });
    expect(message.tool_calls!.map((c) => c.function.arguments)).toEqual([{}, { command: "ls" }]);
  });

  it("sends a bearer token when configured", async () => {
    const { url, last } = await listen(() => ({ json: done }));
    await new OpenAIProvider(url, "k").chat({ model: "m", messages: [], tools: [] });
    expect(last().headers.authorization).toBe("Bearer k");
  });

  it("reports server errors with the status and body excerpt", async () => {
    const { url } = await listen(() => ({ status: 500, json: { error: "boom" } }));
    await expect(
      new OpenAIProvider(url).chat({ model: "m", messages: [], tools: [] }),
    ).rejects.toThrow(/OpenAI-compatible server error: 500 .*boom/);
  });

  it("reports a missing server and passes aborts through", async () => {
    const { url } = await listen(() => undefined);
    await new Promise((resolve) => servers.pop()!.close(resolve));
    await expect(
      new OpenAIProvider(url).chat({ model: "m", messages: [], tools: [] }),
    ).rejects.toThrow(/no OpenAI-compatible server at/);

    const hanging = await listen(() => undefined);
    await expect(
      new OpenAIProvider(hanging.url).chat(
        { model: "m", messages: [], tools: [] },
        AbortSignal.timeout(100),
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("rejects a response without choices", async () => {
    const { url } = await listen(() => ({ json: {} }));
    await expect(
      new OpenAIProvider(url).chat({ model: "m", messages: [], tools: [] }),
    ).rejects.toThrow(/returned no choices/);
  });
});

describe("OpenAIProvider.health", () => {
  it("is true on a 200 from /models and false on 401 or no server", async () => {
    const ok = await listen((req) => ({
      status: req.url === "/v1/models" ? 200 : 404,
      json: { data: [] },
    }));
    expect(await new OpenAIProvider(ok.url).health()).toBe(true);

    const unauthorized = await listen(() => ({ status: 401 }));
    expect(await new OpenAIProvider(unauthorized.url).health()).toBe(false);

    const gone = await listen(() => undefined);
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await new OpenAIProvider(gone.url).health()).toBe(false);
  });
});

describe("createProvider", () => {
  it("picks the provider from the worker config", () => {
    const base = { id: "w", host: "http://h", model: "m" };
    expect(createProvider({ ...base, provider: "ollama" }).kind).toBe("ollama");
    expect(createProvider({ ...base, provider: "openai" }).kind).toBe("openai");
  });
});
