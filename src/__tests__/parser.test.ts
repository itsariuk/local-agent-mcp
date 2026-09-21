// Parser test suite — 14+ test cases covering P0-P2 failure modes from PARSING.md section 7

import { describe, it, expect } from "vitest";
import { parseToolCall, classifyText } from "../parser.js";
import type { ParseFailure, ChatFn } from "../parser.js";
import type { OllamaMessage } from "../ollama.js";

// ---------------------------------------------------------------------------
// Mock helper
// ---------------------------------------------------------------------------

function mockChatFn(responses: string[]): ChatFn {
  let callIndex = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return async (_messages: OllamaMessage[]): Promise<OllamaMessage> => {
    const content = responses[callIndex] ?? "no more responses";
    callIndex++;
    return { role: "assistant", content };
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const noopChatFn: ChatFn = async (_messages: OllamaMessage[]) => {
  throw new Error("chatFn should not have been called");
};

// ---------------------------------------------------------------------------
// Tier 2: Text extraction — P0 (normal-use failures)
// ---------------------------------------------------------------------------

describe("Tier 2: text extraction — P0 cases", () => {
  it("extracts JSON from prose (extra text around JSON)", async () => {
    const content = `Sure! Here's the tool call: {"name": "read_file", "parameters": {"path": "/src/index.ts"}} Hope that helps!`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });

  it("strips markdown code fences (```json wrapper)", async () => {
    const content = '```json\n{"name": "read_file", "parameters": {"path": "/src/index.ts"}}\n```';
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });

  it("handles trailing commas in JSON", async () => {
    const content = `{"name": "read_file", "parameters": {"path": "/src/index.ts",},}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });

  it("picks best from multiple JSON objects (reasoning + tool call)", async () => {
    const content = `{"thinking": "I need to check the file"}\n{"name": "read_file", "parameters": {"path": "/src/index.ts"}}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Field normalization — P0 alias cases
// ---------------------------------------------------------------------------

describe("Tier 2: field normalization — P0 alias cases", () => {
  it("normalizes tool_name alias to name", async () => {
    const content = `{"tool_name": "read_file", "args": {"path": "/src/index.ts"}}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });

  it("normalizes function/arguments aliases", async () => {
    const content = `{"function": "read_file", "arguments": {"path": "/src/index.ts"}}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });

  it("handles double-stringified parameters", async () => {
    const content = `{"name": "read_file", "parameters": "{\\"path\\": \\"/src/index.ts\\"}"}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Lenient repair — P1 (model-specific cases)
// ---------------------------------------------------------------------------

describe("Tier 2: lenient repair — P1 cases", () => {
  it("handles single quotes (Python-style output)", async () => {
    const content = `{'name': 'read_file', 'parameters': {'path': '/src/index.ts'}}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });

  it("handles unquoted keys", async () => {
    const content = `{name: "read_file", parameters: {path: "/src/index.ts"}}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });

  it("handles parameters hoisted to top level", async () => {
    const content = `{"name": "read_file", "path": "/src/index.ts"}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect((calls[0]?.function.arguments as Record<string, unknown>).path).toBe("/src/index.ts");
  });

  it("infers tool name from parameter signature (write_file = path + content)", async () => {
    const content = `{"parameters": {"path": "/out.txt", "content": "hello world"}}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("write_file");
    expect(calls[0]?.function.arguments).toEqual({
      path: "/out.txt",
      content: "hello world",
    });
  });

  it("infers replace_text ahead of read_file/write_file (path + old_text + new_text)", async () => {
    const content = '{"parameters": {"path": "a.ts", "old_text": "x", "new_text": "y"}}';
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as Array<{ function: { name: string } }>;
    expect(calls[0]!.function.name).toBe("replace_text");
  });

  it("strips JS-style line comments", async () => {
    const content = `// Call the read_file tool\n{"name": "read_file", "parameters": {"path": "/src/index.ts"}}`;
    const result = await parseToolCall(content, noopChatFn);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
    expect(calls[0]?.function.arguments).toEqual({ path: "/src/index.ts" });
  });
});

// ---------------------------------------------------------------------------
// Tier 3: Retry — PARSE-04
// ---------------------------------------------------------------------------

describe("Tier 3: retry — PARSE-04", () => {
  it("retries up to 3 times and succeeds on attempt 3", async () => {
    const validJson = `{"name": "read_file", "parameters": {"path": "/src/index.ts"}}`;
    let callCount = 0;
    const trackingChatFn: ChatFn = async (
      _messages: OllamaMessage[], // eslint-disable-line @typescript-eslint/no-unused-vars
    ): Promise<OllamaMessage> => {
      callCount++;
      // Return garbage on first 2 calls, valid JSON on 3rd
      if (callCount < 3) {
        return { role: "assistant", content: "I cannot produce a tool call" };
      }
      return { role: "assistant", content: validJson };
    };

    const result = await parseToolCall("I cannot produce a tool call", trackingChatFn);
    expect(callCount).toBe(3);
    expect(Array.isArray(result)).toBe(true);
    const calls = result as import("../ollama.js").OllamaToolCall[];
    expect(calls[0]?.function.name).toBe("read_file");
  });

  it("includes parse error text in correction prompt", async () => {
    const capturedMessages: OllamaMessage[][] = [];
    const trackingChatFn: ChatFn = async (messages: OllamaMessage[]): Promise<OllamaMessage> => {
      capturedMessages.push(messages);
      return {
        role: "assistant",
        content: `{"name": "read_file", "parameters": {"path": "/src/index.ts"}}`,
      };
    };

    await parseToolCall("not json at all !!!", trackingChatFn);

    // The correction message should reference the parse error
    const firstCallMessages = capturedMessages[0];
    expect(firstCallMessages).toBeDefined();
    const lastMsg = firstCallMessages[firstCallMessages.length - 1];
    expect(lastMsg?.content).toContain("could not be parsed");
    expect(lastMsg?.content).toContain("not json at all");
  });
});

// ---------------------------------------------------------------------------
// ParseFailure return — PARSE-05
// ---------------------------------------------------------------------------

describe("ParseFailure return — PARSE-05", () => {
  it("returns ParseFailure after 3 failed retries (never throws)", async () => {
    const garbageChatFn = mockChatFn(["still garbage", "more garbage", "final garbage"]);

    let threw = false;
    let result: import("../parser.js").ParseFailure | import("../ollama.js").OllamaToolCall[];
    try {
      result = await parseToolCall("garbage input", garbageChatFn);
    } catch {
      threw = true;
      result = {
        reason: "threw",
        rawContent: "",
        attemptCount: 0,
        lastError: "",
      };
    }

    expect(threw).toBe(false);
    expect(Array.isArray(result)).toBe(false);

    const failure = result as ParseFailure;
    expect(failure.reason).toBeTruthy();
    expect(failure.rawContent).toBeTruthy();
    expect(failure.attemptCount).toBe(3);
    expect(failure.lastError).toBeTruthy();
  });

  it("ParseFailure has all required fields", async () => {
    const garbageChatFn = mockChatFn(["bad", "bad", "bad"]);
    const result = await parseToolCall("completely unparseable !!!@@##", garbageChatFn);

    expect(Array.isArray(result)).toBe(false);
    const failure = result as ParseFailure;
    expect(typeof failure.reason).toBe("string");
    expect(typeof failure.rawContent).toBe("string");
    expect(typeof failure.attemptCount).toBe("number");
    expect(typeof failure.lastError).toBe("string");
    expect(failure.attemptCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// P2: Unrecoverable cases — triggers retry
// ---------------------------------------------------------------------------

describe("P2: unrecoverable cases — triggers retry", () => {
  it("truncated JSON triggers retry (chatFn is called)", async () => {
    let called = false;
    const trackingChatFn: ChatFn = async (
      _messages: OllamaMessage[], // eslint-disable-line @typescript-eslint/no-unused-vars
    ): Promise<OllamaMessage> => {
      called = true;
      return {
        role: "assistant",
        content: `{"name": "read_file", "parameters": {"path": "/src/index.ts"}}`,
      };
    };

    const truncated = `{"name": "read_file", "parameters": {"path": "/src/index.t`;
    await parseToolCall(truncated, trackingChatFn);
    expect(called).toBe(true);
  });

  it("completely unparseable text triggers retry (chatFn is called)", async () => {
    let called = false;
    const trackingChatFn: ChatFn = async (
      _messages: OllamaMessage[], // eslint-disable-line @typescript-eslint/no-unused-vars
    ): Promise<OllamaMessage> => {
      called = true;
      return {
        role: "assistant",
        content: `{"name": "read_file", "parameters": {"path": "/src/index.ts"}}`,
      };
    };

    await parseToolCall("I will read the file at /src/index.ts for you.", trackingChatFn);
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyText — tool call vs broken attempt vs final answer
// ---------------------------------------------------------------------------

describe("classifyText", () => {
  const call = '{"name":"bash","arguments":{"command":"npm test"}}';

  it("accepts a whole-message call, fenced or tagged", () => {
    expect(Array.isArray(classifyText(call))).toBe(true);
    expect(Array.isArray(classifyText("```json\n" + call + "\n```"))).toBe(true);
    expect(Array.isArray(classifyText(`<tool_call>${call}</tool_call>`))).toBe(true);
  });

  it("accepts a call after a prose preamble", () => {
    expect(Array.isArray(classifyText(`I'll run the tests: ${call}`))).toBe(true);
  });

  it("treats a call quoted mid-sentence in a report as final", () => {
    expect(classifyText(`Ran ${call} and it passed.`)).toBe("final");
  });

  it("treats an answer opening with a code fence as final", () => {
    expect(classifyText("```diff\n- a\n+ b\n```\nApplied the change.")).toBe("final");
  });

  it("treats a JSON summary with no tool in it as final", () => {
    expect(classifyText('{"summary": "done", "files": ["a.ts"]}')).toBe("final");
  });

  it("flags a truncated attempt after prose as broken", () => {
    const content =
      'I\'ll read the file first:\n```json\n{"name":"read_file","parameters":{"path": "src/x.ts"';
    expect(classifyText(content)).toBe("broken");
  });

  it("treats plain prose as final", () => {
    expect(classifyText("All done. I used read_file and bash.")).toBe("final");
  });
});
