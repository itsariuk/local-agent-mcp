// Ollama HTTP client — typed request/response with native fetch.
// These message types double as the internal chat format (see provider.ts).

import type { ChatRequest, ChatResponse, InferenceProvider } from "./provider.js";

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string; // role:"tool" only — which tool produced this result
  tool_call_id?: string; // role:"tool" only — id of the call being answered, when the backend gave one
}

export interface OllamaToolCall {
  id?: string; // present on native calls from most backends; absent on text-extracted ones
  function: {
    name: string;
    arguments: Record<string, unknown>; // Pre-parsed object, NOT a JSON string
  };
}

export interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaToolDefinition[];
  stream: false;
  format?: "json";
  options?: { num_ctx?: number };
}

export interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export async function chatWithOllama(
  host: string,
  request: OllamaChatRequest,
  signal?: AbortSignal,
): Promise<OllamaChatResponse> {
  const url = `${host}/api/chat`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    // An abort is the caller's doing (cancel/timeout) — pass its reason through untouched
    if (signal?.aborted) throw err;
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === "UND_ERR_HEADERS_TIMEOUT") {
      // ponytail: non-streaming request hit Node fetch's response timeout; switch to stream:true when the provider layer lands
      throw new Error(
        `Ollama at ${host} did not respond in time -- the generation is too long for a non-streaming request`,
        { cause: err },
      );
    }
    throw new Error(`Ollama is not running at ${host} -- start it with: ollama serve`, {
      cause: err,
    });
  }

  if (!resp.ok) {
    throw new Error(`Ollama error: ${resp.status} ${resp.statusText}`);
  }

  return (await resp.json()) as OllamaChatResponse;
}

const HEALTH_TIMEOUT_MS = 3000;

/** Liveness probe. Never throws; does not load a model. */
export async function checkHealth(host: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const resp = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Provider wrapper
// ---------------------------------------------------------------------------

export class OllamaProvider implements InferenceProvider {
  readonly kind = "ollama" as const;

  constructor(private readonly host: string) {}

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const response = await chatWithOllama(
      this.host,
      {
        model: request.model,
        messages: request.messages,
        tools: request.tools,
        stream: false,
        ...(request.jsonOnly && { format: "json" as const }),
        ...(request.numCtx && { options: { num_ctx: request.numCtx } }),
      },
      signal,
    );
    return {
      message: response.message,
      ...(response.prompt_eval_count !== undefined && {
        usage: {
          promptTokens: response.prompt_eval_count,
          completionTokens: response.eval_count ?? 0,
        },
      }),
    };
  }

  health(): Promise<boolean> {
    return checkHealth(this.host);
  }
}
