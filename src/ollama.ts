// Ollama HTTP client — typed request/response with native fetch

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string; // role:"tool" only — which tool produced this result
}

export interface OllamaToolCall {
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
