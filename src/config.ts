/**
 * Configuration module — reads environment variables at startup with
 * documented defaults and fail-fast validation.
 *
 * Covers CONF-01 through CONF-12.
 */

import os from "node:os";
import path from "node:path";
import { DEFAULT_ALLOWED_COMMANDS } from "./security.js";
import type { ShellMode } from "./security.js";

// ---------------------------------------------------------------------------
// ConfigError
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(envKey: string, value: string, expected: string) {
    super(`${envKey}=${value} is not valid, expected: ${expected}`);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// AppConfig
// ---------------------------------------------------------------------------

export type ProviderKind = "ollama" | "openai";

export interface WorkerConfig {
  id: string;
  host: string;
  model: string;
  provider: ProviderKind;
}

export interface AppConfig {
  workers: readonly WorkerConfig[];
  model: string;
  workingDir: string;
  maxIterations: number;
  timeoutMs: number;
  shellMode: ShellMode;
  allowedCommands: readonly string[];
  numCtx?: number;
  jobTimeoutMs: number;
  apiKey?: string;
  jobLogDir: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SHELL_MODES: readonly ShellMode[] = ["restricted", "full", "none"];

function parsePositiveInt(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(envKey, raw, "a positive integer");
  }
  return parsed;
}

const WORKER_ID = /^[\w-]+$/;

// A base URL ending in /v1 is an OpenAI-compatible server (vLLM, llama.cpp,
// LM Studio, Ollama's own /v1); anything else is Ollama's native API.
function workerFor(id: string, url: string, model: string): WorkerConfig {
  const host = url.replace(/\/+$/, "");
  return { id, host, model, provider: /\/v1$/.test(host) ? "openai" : "ollama" };
}

function parseWorkers(raw: string, model: string): WorkerConfig[] {
  const expected = "id=http://host:port[,id=http://host:port...]";
  const workers: WorkerConfig[] = [];
  for (const entry of raw.split(",").map((s) => s.trim())) {
    // First "=" only: the URL itself may contain one
    const eq = entry.indexOf("=");
    const id = entry.slice(0, eq).trim();
    const url = entry.slice(eq + 1).trim();
    if (
      eq < 1 ||
      !WORKER_ID.test(id) ||
      !/^https?:\/\//.test(url) ||
      !URL.canParse(url) ||
      workers.some((w) => w.id === id)
    ) {
      throw new ConfigError("AGENT_WORKERS", raw, expected);
    }
    workers.push(workerFor(id, url, model));
  }
  return workers;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export function loadConfig(): AppConfig {
  // CONF-02
  const model = process.env.AGENT_MODEL ?? "qwen2.5-coder:7b";

  // CONF-01 / CONF-09: AGENT_WORKERS wins; OLLAMA_HOST alone means one worker
  const rawWorkers = process.env.AGENT_WORKERS;
  const workers =
    rawWorkers !== undefined
      ? parseWorkers(rawWorkers, model)
      : [workerFor("default", process.env.OLLAMA_HOST ?? "http://localhost:11434", model)];

  // CONF-03
  const workingDir = process.env.AGENT_WORKING_DIR ?? process.cwd();

  // CONF-04
  const maxIterations = parsePositiveInt("AGENT_MAX_ITERATIONS", 20);

  // CONF-05
  const timeoutSeconds = parsePositiveInt("AGENT_TIMEOUT_SECONDS", 120);
  const timeoutMs = timeoutSeconds * 1000;

  // CONF-06
  const rawShellMode = process.env.AGENT_SHELL_MODE ?? "restricted";
  if (!VALID_SHELL_MODES.includes(rawShellMode as ShellMode)) {
    throw new ConfigError("AGENT_SHELL_MODE", rawShellMode, "restricted | full | none");
  }
  const shellMode = rawShellMode as ShellMode;

  // CONF-07
  const rawAllowed = process.env.AGENT_ALLOWED_COMMANDS;
  const extraCommands = rawAllowed
    ? rawAllowed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const allowedCommands = [...DEFAULT_ALLOWED_COMMANDS, ...extraCommands];

  // CONF-08: unset means "send no options" — Ollama's own default applies
  const numCtx =
    process.env.AGENT_NUM_CTX === undefined ? undefined : parsePositiveInt("AGENT_NUM_CTX", 0);

  // CONF-10: whole-job wall clock; the job returns what it has when it expires
  const jobTimeoutMs = parsePositiveInt("AGENT_JOB_TIMEOUT_SECONDS", 900) * 1000;

  // CONF-11: bearer token for OpenAI-compatible servers that want one
  const apiKey = process.env.AGENT_API_KEY || undefined;

  // CONF-12: per-job records; outside the repo so they never land in a checkout or a worktree snapshot
  // `||`: an empty value means unset (XDG says so), and must never resolve to the cwd
  const jobLogDir =
    process.env.AGENT_JOB_LOG_DIR ||
    path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
      "local-agent-mcp",
      "jobs",
    );

  return {
    workers,
    model,
    workingDir,
    maxIterations,
    timeoutMs,
    shellMode,
    allowedCommands,
    numCtx,
    jobTimeoutMs,
    apiKey,
    jobLogDir,
  };
}
