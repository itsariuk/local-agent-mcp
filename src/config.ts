/**
 * Configuration module — reads environment variables at startup with
 * documented defaults and fail-fast validation.
 *
 * Covers CONF-01 through CONF-08.
 */

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

export interface AppConfig {
  ollamaHost: string;
  model: string;
  workingDir: string;
  maxIterations: number;
  timeoutMs: number;
  shellMode: ShellMode;
  allowedCommands: readonly string[];
  numCtx?: number;
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

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export function loadConfig(): AppConfig {
  // CONF-01
  const ollamaHost = process.env.OLLAMA_HOST ?? "http://localhost:11434";

  // CONF-02
  const model = process.env.AGENT_MODEL ?? "qwen2.5-coder:7b";

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

  return {
    ollamaHost,
    model,
    workingDir,
    maxIterations,
    timeoutMs,
    shellMode,
    allowedCommands,
    numCtx,
  };
}
