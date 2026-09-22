import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, ConfigError } from "../config.js";
import { DEFAULT_ALLOWED_COMMANDS } from "../security.js";

// ---------------------------------------------------------------------------
// Environment snapshot — restore after each test
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "OLLAMA_HOST",
  "AGENT_MODEL",
  "AGENT_WORKING_DIR",
  "AGENT_MAX_ITERATIONS",
  "AGENT_TIMEOUT_SECONDS",
  "AGENT_SHELL_MODE",
  "AGENT_ALLOWED_COMMANDS",
  "AGENT_NUM_CTX",
  "AGENT_WORKERS",
  "AGENT_JOB_TIMEOUT_SECONDS",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    snap[k] = process.env[k];
  }
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = snap[k];
    }
  }
}

describe("loadConfig", () => {
  let saved: Record<string, string | undefined>;

  afterEach(() => {
    restoreEnv(saved);
  });

  // Utility: clear all config env vars and snapshot
  function setup(overrides: Record<string, string> = {}): void {
    saved = snapshotEnv();
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(overrides)) {
      process.env[k] = v;
    }
  }

  // -------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------

  it("returns defaults when no env vars set", () => {
    setup();
    const config = loadConfig();
    expect(config.workers).toEqual([
      { id: "default", host: "http://localhost:11434", model: "qwen2.5-coder:7b" },
    ]);
    expect(config.model).toBe("qwen2.5-coder:7b");
    expect(config.workingDir).toBe(process.cwd());
    expect(config.maxIterations).toBe(20);
    expect(config.timeoutMs).toBe(120_000);
    expect(config.numCtx).toBeUndefined();
    expect(config.jobTimeoutMs).toBe(900_000);
    expect(config.shellMode).toBe("restricted");
    // All default commands present
    for (const cmd of DEFAULT_ALLOWED_COMMANDS) {
      expect(config.allowedCommands).toContain(cmd);
    }
  });

  // -------------------------------------------------------------------
  // CONF-08: AGENT_NUM_CTX
  // -------------------------------------------------------------------

  it("AGENT_NUM_CTX=32768 sets numCtx", () => {
    setup({ AGENT_NUM_CTX: "32768" });
    expect(loadConfig().numCtx).toBe(32768);
  });

  it("AGENT_NUM_CTX=abc throws ConfigError", () => {
    setup({ AGENT_NUM_CTX: "abc" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  // -------------------------------------------------------------------
  // CONF-01: OLLAMA_HOST
  // -------------------------------------------------------------------

  it("OLLAMA_HOST sets the host of the single default worker", () => {
    setup({ OLLAMA_HOST: "http://custom:1234" });
    const config = loadConfig();
    expect(config.workers).toHaveLength(1);
    expect(config.workers[0]!.host).toBe("http://custom:1234");
  });

  // -------------------------------------------------------------------
  // CONF-10: AGENT_JOB_TIMEOUT_SECONDS
  // -------------------------------------------------------------------

  it("AGENT_JOB_TIMEOUT_SECONDS=60 sets jobTimeoutMs", () => {
    setup({ AGENT_JOB_TIMEOUT_SECONDS: "60" });
    expect(loadConfig().jobTimeoutMs).toBe(60_000);
  });

  it("AGENT_JOB_TIMEOUT_SECONDS=abc throws ConfigError", () => {
    setup({ AGENT_JOB_TIMEOUT_SECONDS: "abc" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  // -------------------------------------------------------------------
  // CONF-09: AGENT_WORKERS
  // -------------------------------------------------------------------

  it("AGENT_WORKERS defines several workers, trimmed, sharing AGENT_MODEL", () => {
    setup({ AGENT_WORKERS: "gpu0=http://a:11434, gpu1=http://a:11435/", AGENT_MODEL: "m" });
    expect(loadConfig().workers).toEqual([
      { id: "gpu0", host: "http://a:11434", model: "m" },
      { id: "gpu1", host: "http://a:11435", model: "m" },
    ]);
  });

  it("AGENT_WORKERS wins over OLLAMA_HOST", () => {
    setup({ AGENT_WORKERS: "gpu0=http://a:11434", OLLAMA_HOST: "http://ignored:1" });
    expect(loadConfig().workers.map((w) => w.host)).toEqual(["http://a:11434"]);
  });

  it.each([
    ["no equals sign", "gpu0"],
    ["empty id", "=http://a:1"],
    ["id with a space", "gpu 0=http://a:1"],
    ["not a URL", "gpu0=notaurl"],
    ["non-http scheme", "gpu0=ftp://a:1"],
    ["duplicate id", "gpu0=http://a:1,gpu0=http://b:1"],
    ["empty value", ""],
  ])("AGENT_WORKERS with %s throws ConfigError", (_name, value) => {
    setup({ AGENT_WORKERS: value });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  // -------------------------------------------------------------------
  // CONF-02: AGENT_MODEL
  // -------------------------------------------------------------------

  it("AGENT_MODEL overrides model", () => {
    setup({ AGENT_MODEL: "llama3.1:8b" });
    const config = loadConfig();
    expect(config.model).toBe("llama3.1:8b");
  });

  // -------------------------------------------------------------------
  // CONF-03: AGENT_WORKING_DIR
  // -------------------------------------------------------------------

  it("AGENT_WORKING_DIR overrides workingDir", () => {
    setup({ AGENT_WORKING_DIR: "/tmp" });
    const config = loadConfig();
    expect(config.workingDir).toBe("/tmp");
  });

  // -------------------------------------------------------------------
  // CONF-04: AGENT_MAX_ITERATIONS
  // -------------------------------------------------------------------

  it("AGENT_MAX_ITERATIONS=5 overrides maxIterations to 5", () => {
    setup({ AGENT_MAX_ITERATIONS: "5" });
    const config = loadConfig();
    expect(config.maxIterations).toBe(5);
  });

  it("AGENT_MAX_ITERATIONS=abc throws ConfigError", () => {
    setup({ AGENT_MAX_ITERATIONS: "abc" });
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(
      /AGENT_MAX_ITERATIONS=abc is not valid, expected: a positive integer/,
    );
  });

  it("AGENT_MAX_ITERATIONS=0 throws ConfigError", () => {
    setup({ AGENT_MAX_ITERATIONS: "0" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("AGENT_MAX_ITERATIONS=-5 throws ConfigError", () => {
    setup({ AGENT_MAX_ITERATIONS: "-5" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  // -------------------------------------------------------------------
  // CONF-05: AGENT_TIMEOUT_SECONDS
  // -------------------------------------------------------------------

  it("AGENT_TIMEOUT_SECONDS=60 sets timeoutMs to 60000", () => {
    setup({ AGENT_TIMEOUT_SECONDS: "60" });
    const config = loadConfig();
    expect(config.timeoutMs).toBe(60_000);
  });

  it("AGENT_TIMEOUT_SECONDS=0 throws ConfigError", () => {
    setup({ AGENT_TIMEOUT_SECONDS: "0" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("AGENT_TIMEOUT_SECONDS=3.5 throws ConfigError (non-integer)", () => {
    setup({ AGENT_TIMEOUT_SECONDS: "3.5" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  // -------------------------------------------------------------------
  // CONF-06: AGENT_SHELL_MODE
  // -------------------------------------------------------------------

  it("AGENT_SHELL_MODE=full overrides shellMode", () => {
    setup({ AGENT_SHELL_MODE: "full" });
    const config = loadConfig();
    expect(config.shellMode).toBe("full");
  });

  it("AGENT_SHELL_MODE=none overrides shellMode", () => {
    setup({ AGENT_SHELL_MODE: "none" });
    const config = loadConfig();
    expect(config.shellMode).toBe("none");
  });

  it("AGENT_SHELL_MODE=typo throws ConfigError", () => {
    setup({ AGENT_SHELL_MODE: "typo" });
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(
      /AGENT_SHELL_MODE=typo is not valid, expected: restricted \| full \| none/,
    );
  });

  // -------------------------------------------------------------------
  // CONF-07: AGENT_ALLOWED_COMMANDS
  // -------------------------------------------------------------------

  it("AGENT_ALLOWED_COMMANDS='rm, curl' merges with defaults", () => {
    setup({ AGENT_ALLOWED_COMMANDS: "rm, curl" });
    const config = loadConfig();
    expect(config.allowedCommands).toContain("rm");
    expect(config.allowedCommands).toContain("curl");
    // Defaults still present
    expect(config.allowedCommands).toContain("git");
  });

  it("AGENT_ALLOWED_COMMANDS='' does not add empty string", () => {
    setup({ AGENT_ALLOWED_COMMANDS: "" });
    const config = loadConfig();
    expect(config.allowedCommands).not.toContain("");
    // Defaults still present
    expect(config.allowedCommands).toContain("git");
  });
});
