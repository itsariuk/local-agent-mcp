// Inference providers — the agent loop talks to this interface only.
// The internal chat format is the Ollama shape (object tool arguments);
// each provider translates to its own wire format.

import type { OllamaMessage, OllamaToolCall, OllamaToolDefinition } from "./ollama.js";
import { OllamaProvider } from "./ollama.js";
import type { ProviderKind, WorkerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export type ChatMessage = OllamaMessage;
export type ToolCall = OllamaToolCall;
export type ToolDefinition = OllamaToolDefinition;

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  jsonOnly?: boolean; // parser correction turns
  numCtx?: number; // Ollama only
}

export interface ChatResponse {
  message: ChatMessage;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface InferenceProvider {
  readonly kind: ProviderKind;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  health(): Promise<boolean>;
}

export function createProvider(worker: WorkerConfig, apiKey?: string): InferenceProvider {
  return worker.provider === "openai"
    ? new OpenAIProvider(worker.host, apiKey)
    : new OllamaProvider(worker.host);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (vLLM, llama.cpp server, LM Studio, Ollama /v1)
// ---------------------------------------------------------------------------

// Wire types: only what we send and read. Unknown fields are never echoed back.
interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: ChatMessage["role"];
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIChatCompletion {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const HEALTH_TIMEOUT_MS = 3000;

/**
 * Object arguments → JSON string; tool results carry the call's id. Calls that
 * came from text extraction have no id, so one is invented and the tool
 * messages that follow (one per call, in order) are pointed at it.
 */
export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  let pendingIds: string[] = [];
  let counter = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((tc) => ({
        id: tc.id ?? `call_${counter++}`,
        type: "function" as const,
        function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
      }));
      pendingIds = calls.map((c) => c.id);
      out.push({ role: "assistant", content: m.content, tool_calls: calls });
    } else if (m.role === "tool") {
      const id = m.tool_call_id ?? pendingIds.shift();
      out.push({ role: "tool", content: m.content, ...(id && { tool_call_id: id }) });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function fromOpenAIMessage(
  m: NonNullable<OpenAIChatCompletion["choices"]>[number]["message"],
): ChatMessage {
  const toolCalls = (m?.tool_calls ?? []).map((tc, i) => {
    let args: Record<string, unknown> = {};
    const raw = tc.function?.arguments;
    if (typeof raw === "object" && raw !== null) {
      args = raw as Record<string, unknown>; // some servers already send an object
    } else if (typeof raw === "string" && raw.trim() !== "") {
      try {
        args = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        console.error(`[provider] tool call ${tc.function?.name} had unparseable arguments`);
      }
    }
    return {
      id: tc.id ?? `call_${i}`,
      function: { name: tc.function?.name ?? "", arguments: args },
    };
  });
  return {
    role: "assistant",
    content: m?.content ?? "",
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  };
}

export class OpenAIProvider implements InferenceProvider {
  readonly kind = "openai" as const;

  constructor(
    private readonly base: string,
    private readonly apiKey?: string,
  ) {}

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const body = {
      model: request.model,
      messages: toOpenAIMessages(request.messages),
      stream: false,
      // An empty tools array is rejected by some servers
      ...(request.tools.length > 0 && { tools: request.tools }),
      ...(request.jsonOnly && { response_format: { type: "json_object" } }),
    };
    const resp = await this.fetch(
      "/chat/completions",
      { method: "POST", body: JSON.stringify(body) },
      signal,
    );
    const data = (await resp.json()) as OpenAIChatCompletion;
    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error(`OpenAI-compatible server at ${this.base} returned no choices`);
    }
    return {
      message: fromOpenAIMessage(message),
      ...(data.usage?.prompt_tokens !== undefined && {
        usage: {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens ?? 0,
        },
      }),
    };
  }

  async health(): Promise<boolean> {
    try {
      const resp = await this.fetch("/models", {}, AbortSignal.timeout(HEALTH_TIMEOUT_MS));
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async fetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let resp: Response;
    try {
      resp = await fetch(`${this.base}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
        },
        signal,
      });
    } catch (err) {
      // An abort is the caller's doing (cancel/timeout) — pass its reason through untouched
      if (signal?.aborted) throw err;
      throw new Error(`no OpenAI-compatible server at ${this.base} -- is it running?`, {
        cause: err,
      });
    }
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `OpenAI-compatible server error: ${resp.status} ${resp.statusText}${detail ? ` -- ${detail}` : ""}`,
      );
    }
    return resp;
  }
}
