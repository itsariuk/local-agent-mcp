// Three-tier tool call parser — handles all documented model output failure modes.
// Tier 1: native tool_calls (handled upstream in loop.ts)
// Tier 2: text extraction pipeline (7 strategies)
// Tier 3: retry with correction prompt (up to 3 retries)
//
// Never throws — always returns OllamaToolCall[] | ParseFailure.

import type { OllamaMessage, OllamaToolCall } from "./ollama.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type ChatFn = (messages: OllamaMessage[]) => Promise<OllamaMessage>;

export interface ParseFailure {
  reason: string;
  rawContent: string;
  attemptCount: number;
  lastError: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAME_ALIASES = ["name", "tool_name", "function", "action", "tool", "function_name"] as const;

const PARAMS_ALIASES = [
  "parameters",
  "arguments",
  "args",
  "params",
  "input",
  "kwargs",
  "inputs",
] as const;

const TOOL_SIGNATURES: Record<string, string[]> = {
  // Most specific first: inferToolName takes the first signature whose keys are
  // all present, and read_file/list_dir need only "path"
  replace_text: ["path", "old_text", "new_text"],
  write_file: ["path", "content"],
  read_file: ["path"],
  list_dir: ["path"],
  bash: ["command"],
};

const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Internal extraction helpers
// ---------------------------------------------------------------------------

function tryDirectParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

function stripProse(raw: string): string {
  let s = raw.trim();
  // Remove markdown code fences (opening)
  s = s.replace(/^```(?:json|tool_call|javascript|js)?\s*/i, "");
  // Remove markdown code fences (closing)
  s = s.replace(/\s*```\s*$/i, "");
  // Remove preamble before first { or [
  s = s.replace(/^[^{[]*(?=[{[])/s, "");
  // Remove postamble after last } or ]
  s = s.replace(/(?<=[}\]])[^}\]]*$/s, "");
  return s.trim();
}

/**
 * Extract first balanced JSON object or array using depth-tracking walk.
 * Uses balanced-brace depth tracking — NOT greedy regex.
 */
function extractFirstJson(raw: string): string | null {
  const startObj = raw.indexOf("{");
  const startArr = raw.indexOf("[");

  if (startObj === -1 && startArr === -1) return null;

  let start: number;
  if (startObj === -1) start = startArr;
  else if (startArr === -1) start = startObj;
  else start = Math.min(startObj, startArr);

  const opener = raw[start] as "{" | "[";
  const closer = opener === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === opener) depth++;
    if (ch === closer) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null; // unbalanced / truncated
}

function lenientRepair(raw: string): string {
  let s = raw;

  // Strip JS-style // line comments
  s = s.replace(/\/\/[^\n]*/g, "");
  // Strip JS-style /* */ block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");

  // Trailing commas before } or ]
  s = s.replace(/,(\s*[}\]])/g, "$1");

  // Single quotes to double quotes — ONLY if no double quotes present at all
  if (!s.includes('"') && s.includes("'")) {
    s = s.replace(/'/g, '"');
  }

  // Quote unquoted keys: {name: "..."} -> {"name": "..."}
  s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

  return s;
}

function extractAllJsonObjects(raw: string): unknown[] {
  const results: unknown[] = [];
  let remaining = raw;
  while (true) {
    const fragment = extractFirstJson(remaining);
    if (!fragment) break;
    const parsed = tryDirectParse(fragment);
    if (parsed !== null) results.push(parsed);
    const idx = remaining.indexOf(fragment) + fragment.length;
    remaining = remaining.slice(idx);
    if (idx >= raw.length) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function inferToolName(params: Record<string, unknown>): string | null {
  const keys = new Set(Object.keys(params));
  for (const [tool, required] of Object.entries(TOOL_SIGNATURES)) {
    if (required.every((k) => keys.has(k))) return tool;
  }
  return null;
}

function normalizeToolCall(
  raw: unknown,
): { name: string; parameters: Record<string, unknown> } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // Resolve name
  let name: string | undefined;
  for (const alias of NAME_ALIASES) {
    if (typeof obj[alias] === "string") {
      name = obj[alias] as string;
      break;
    }
  }

  // Resolve parameters
  let parameters: Record<string, unknown> | undefined;
  for (const alias of PARAMS_ALIASES) {
    const val = obj[alias];
    if (val !== null && val !== undefined) {
      if (typeof val === "object" && !Array.isArray(val)) {
        parameters = val as Record<string, unknown>;
        break;
      }
      // Double-stringified parameters — the value is a JSON string
      if (typeof val === "string") {
        try {
          const parsed = JSON.parse(val);
          if (typeof parsed === "object" && parsed !== null) {
            parameters = parsed as Record<string, unknown>;
            break;
          }
        } catch {
          // not parseable as JSON, continue to next alias
        }
      }
    }
  }

  // Fallback: parameters hoisted to top level (e.g. {"name": "read_file", "path": "/..."})
  if (parameters === undefined && name !== undefined) {
    const residual: Record<string, unknown> = { ...obj };
    for (const alias of [...NAME_ALIASES, ...PARAMS_ALIASES]) {
      delete residual[alias];
    }
    if (Object.keys(residual).length > 0) {
      parameters = residual;
    }
  }

  // If still no name, try inferring from parameters
  if (name === undefined && parameters !== undefined) {
    const inferred = inferToolName(parameters);
    if (inferred !== null) name = inferred;
  }

  if (name === undefined) return null;

  return { name, parameters: parameters ?? {} };
}

function toOllamaToolCall(tc: {
  name: string;
  parameters: Record<string, unknown>;
}): OllamaToolCall {
  return {
    function: {
      name: tc.name,
      arguments: tc.parameters,
    },
  };
}

function pickBestToolCall(
  candidates: unknown[],
): { name: string; parameters: Record<string, unknown> } | null {
  const knownTools = new Set(Object.keys(TOOL_SIGNATURES));
  // Prefer candidates that normalize AND have a known tool name
  for (const candidate of candidates) {
    const normalized = normalizeToolCall(candidate);
    if (normalized !== null && knownTools.has(normalized.name)) return normalized;
  }
  // Fallback: first that normalizes at all
  for (const candidate of candidates) {
    const normalized = normalizeToolCall(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6-strategy extraction pipeline
// ---------------------------------------------------------------------------

function extractToolCalls(raw: string): OllamaToolCall[] | null {
  const strategies: Array<() => unknown | null> = [
    // Strategy 1: direct JSON parse
    () => tryDirectParse(raw),
    // Strategy 2: strip prose, then direct parse
    () => tryDirectParse(stripProse(raw)),
    // Strategy 3: extract first JSON object, direct parse
    () => {
      const s = extractFirstJson(raw);
      return s !== null ? tryDirectParse(s) : null;
    },
    // Strategy 4: extract first JSON, lenient repair, direct parse
    () => {
      const s = extractFirstJson(raw);
      return s !== null ? tryDirectParse(lenientRepair(s)) : null;
    },
    // Strategy 5: lenient repair of stripped prose, direct parse
    () => tryDirectParse(lenientRepair(stripProse(raw))),
    // Strategy 6: extract all JSON objects, pick best match
    () => {
      const all = extractAllJsonObjects(raw);
      if (all.length === 0) return null;
      return pickBestToolCall(all);
    },
  ];

  for (const strategy of strategies) {
    let parsed: unknown | null;
    try {
      parsed = strategy();
    } catch {
      continue;
    }
    if (parsed === null || parsed === undefined) continue;

    const normalized = normalizeToolCall(parsed);
    if (normalized !== null) {
      return [toOllamaToolCall(normalized)];
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Text classification (no retry) — tool call, broken attempt, or final answer
// ---------------------------------------------------------------------------

const BROKEN_ATTEMPT = new RegExp(`<tool_call>|"(${Object.keys(TOOL_SIGNATURES).join("|")})"`);

/**
 * Decide what a message without native tool_calls is.
 *
 * - A parseable call counts only when the JSON sits at the start or end of the
 *   message. JSON in the middle of a sentence is the model quoting a call in
 *   its report, and executing it would re-run the command.
 * - "broken" means the text names a tool (or uses <tool_call>) but nothing
 *   parsed, wherever the attempt sits — that is worth a correction retry.
 * - Everything else, including answers that open with a code fence, is final.
 */
export function classifyText(raw: string): OllamaToolCall[] | "broken" | "final" {
  const calls = extractToolCalls(raw);
  if (calls !== null) {
    const bare = raw.replace(/```\w*|<\/?tool_call>/g, "").trim();
    return /^[{[]|[}\]]$/.test(bare) ? calls : "final";
  }
  return BROKEN_ATTEMPT.test(raw) ? "broken" : "final";
}

// ---------------------------------------------------------------------------
// Parse error description helper
// ---------------------------------------------------------------------------

function getParseError(content: string): string {
  if (content.trim() === "") return "Empty response from model";

  const hasOpenBrace = content.includes("{") || content.includes("[");
  if (!hasOpenBrace) return "No JSON object found in response";

  const extracted = extractFirstJson(content);
  if (extracted === null) return "Truncated JSON -- no closing brace found";

  try {
    JSON.parse(extracted);
    return "JSON parsed but missing tool name or unrecognized structure";
  } catch (e) {
    return `JSON parse error: ${String(e)}`;
  }
}

// ---------------------------------------------------------------------------
// Correction prompt builder
// ---------------------------------------------------------------------------

function buildCorrectionMessages(badOutput: string, parseError: string): OllamaMessage[] {
  const correctionText =
    `Your previous response could not be parsed as a tool call.\n\n` +
    `Here is what you returned:\n<previous_response>\n${badOutput}\n</previous_response>\n\n` +
    `The parsing error was: ${parseError}\n\n` +
    `IMPORTANT: Your response must be ONLY a JSON object with no other text. Required format:\n` +
    `{"name": "<tool_name>", "parameters": {<key>: <value>}}\n\n` +
    `Do not include any explanation, preamble, or text outside the JSON object.`;

  return [{ role: "user", content: correctionText }];
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Parse a tool call from model output text.
 *
 * Returns OllamaToolCall[] on success, or ParseFailure after max retries.
 * Never throws.
 */
export async function parseToolCall(
  content: string,
  chatFn: ChatFn,
): Promise<OllamaToolCall[] | ParseFailure> {
  // Initial extraction attempt
  const initial = extractToolCalls(content);
  if (initial !== null) return initial;

  // Enter retry loop
  let rawContent = content;
  let lastError = getParseError(content);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const correctionMessages = buildCorrectionMessages(rawContent, lastError);

    let response: OllamaMessage;
    try {
      response = await chatFn(correctionMessages);
    } catch (e) {
      lastError = `chatFn threw: ${String(e)}`;
      continue;
    }

    rawContent = response.content;
    const retryResult = extractToolCalls(rawContent);
    if (retryResult !== null) return retryResult;

    lastError = getParseError(rawContent);
  }

  return {
    reason: lastError,
    rawContent,
    attemptCount: MAX_RETRIES,
    lastError,
  };
}
