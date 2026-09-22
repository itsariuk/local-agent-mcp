import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeTool, TOOL_DEFINITIONS, toolDefinitions } from "../tools.js";
import { DEFAULT_ALLOWED_COMMANDS } from "../security.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

let tempDir: string;
const shellMode = "restricted" as const;
const allowedCommands = DEFAULT_ALLOWED_COMMANDS;
const timeoutMs = 5000;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-test-"));
  await fs.writeFile(path.join(tempDir, "test.txt"), "hello world", "utf-8");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("TOOL_DEFINITIONS", () => {
  it("has 5 tool definitions", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(5);
  });

  it("each has a description longer than 50 characters", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.function.description.length).toBeGreaterThan(50);
    }
  });
});

describe("toolDefinitions", () => {
  it("drops the write tools in read-only mode", () => {
    expect(toolDefinitions(true).map((t) => t.function.name)).toEqual([
      "read_file",
      "list_dir",
      "bash",
    ]);
    expect(toolDefinitions(false)).toBe(TOOL_DEFINITIONS);
  });
});

describe("read-only mode", () => {
  const exists = (name: string) =>
    fs.access(path.join(tempDir, name)).then(
      () => true,
      () => false,
    );

  it("refuses write_file and replace_text without touching the file", async () => {
    const write = await executeTool(
      "write_file",
      { path: "new.txt", content: "x" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
      true,
    );
    expect(write.success).toBe(false);
    expect(write.output).toContain("read-only");
    expect(await exists("new.txt")).toBe(false);

    const replace = await executeTool(
      "replace_text",
      { path: "test.txt", old_text: "world", new_text: "x" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
      true,
    );
    expect(replace.success).toBe(false);
    expect(await fs.readFile(path.join(tempDir, "test.txt"), "utf-8")).toBe("hello world");
  });

  it("still reads", async () => {
    const result = await executeTool(
      "read_file",
      { path: "test.txt" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
      true,
    );
    expect(result.output).toBe("hello world");
  });

  it.skipIf(process.platform === "win32")(
    "limits bash to the read-only profile even in full shell mode",
    async () => {
      const redirect = await executeTool(
        "bash",
        { command: "echo hi > f" },
        tempDir,
        "full",
        allowedCommands,
        timeoutMs,
        true,
      );
      expect(redirect.success).toBe(false);
      expect(await exists("f")).toBe(false);

      const npm = await executeTool(
        "bash",
        { command: "npm --version" },
        tempDir,
        "full",
        allowedCommands,
        timeoutMs,
        true,
      );
      expect(npm.success).toBe(false);

      const echo = await executeTool(
        "bash",
        { command: "echo hi" },
        tempDir,
        "full",
        allowedCommands,
        timeoutMs,
        true,
      );
      expect(echo.success).toBe(true);
      expect(echo.output).toContain("hi");
    },
  );
});

describe("read_file", () => {
  it("reads existing file", async () => {
    const result = await executeTool(
      "read_file",
      { path: "test.txt" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe("hello world");
  });

  it("fails on missing file", async () => {
    const result = await executeTool(
      "read_file",
      { path: "nope.txt" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
  });

  it("rejects path outside working dir", async () => {
    const result = await executeTool(
      "read_file",
      { path: "../../etc/passwd" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("path not allowed");
  });
});

describe("write_file", () => {
  it("writes new file", async () => {
    const result = await executeTool(
      "write_file",
      { path: "new.txt", content: "hello" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(true);
    const written = await fs.readFile(path.join(tempDir, "new.txt"), "utf-8");
    expect(written).toBe("hello");
  });

  it("creates intermediate directories", async () => {
    const result = await executeTool(
      "write_file",
      { path: "deep/nested/file.txt", content: "nested" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(true);
    const written = await fs.readFile(path.join(tempDir, "deep", "nested", "file.txt"), "utf-8");
    expect(written).toBe("nested");
  });

  it("rejects path outside working dir", async () => {
    const result = await executeTool(
      "write_file",
      { path: "../../evil.txt", content: "bad" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("path not allowed");
  });
});

describe("replace_text", () => {
  const readTest = () => fs.readFile(path.join(tempDir, "test.txt"), "utf-8");

  it("replaces a unique match", async () => {
    const result = await executeTool(
      "replace_text",
      { path: "test.txt", old_text: "world", new_text: "there" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(true);
    expect(await readTest()).toBe("hello there");
  });

  it("writes new_text literally (no $ substitution patterns)", async () => {
    const result = await executeTool(
      "replace_text",
      { path: "test.txt", old_text: "world", new_text: "$&x" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(true);
    expect(await readTest()).toBe("hello $&x");
  });

  it("fails when old_text is not found", async () => {
    const result = await executeTool(
      "replace_text",
      { path: "test.txt", old_text: "zzz", new_text: "y" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
    expect(await readTest()).toBe("hello world");
  });

  it("fails when old_text is ambiguous", async () => {
    await fs.writeFile(path.join(tempDir, "test.txt"), "a a", "utf-8");
    const result = await executeTool(
      "replace_text",
      { path: "test.txt", old_text: "a", new_text: "b" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("2 occurrences");
    expect(await readTest()).toBe("a a");
  });

  it("fails when new_text is missing, but allows an empty string (deletion)", async () => {
    const missing = await executeTool(
      "replace_text",
      { path: "test.txt", old_text: " world" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(missing.success).toBe(false);
    expect(await readTest()).toBe("hello world");

    const deletion = await executeTool(
      "replace_text",
      { path: "test.txt", old_text: " world", new_text: "" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(deletion.success).toBe(true);
    expect(await readTest()).toBe("hello");
  });

  it("fails on empty old_text", async () => {
    const result = await executeTool(
      "replace_text",
      { path: "test.txt", old_text: "", new_text: "y" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
    expect(await readTest()).toBe("hello world");
  });

  it("rejects path outside working dir", async () => {
    const result = await executeTool(
      "replace_text",
      { path: "../../evil.txt", old_text: "a", new_text: "b" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("path not allowed");
  });
});

describe("list_dir", () => {
  it("lists directory contents", async () => {
    const result = await executeTool(
      "list_dir",
      { path: "." },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("test.txt");
    expect(result.output).toContain("f");
  });

  it("fails on missing directory", async () => {
    const result = await executeTool(
      "list_dir",
      { path: "nope" },
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
  });
});

describe("bash", () => {
  it.skipIf(process.platform === "win32")("executes allowed command", async () => {
    const result = await executeTool(
      "bash",
      { command: "echo hello" },
      tempDir,
      "restricted",
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it.skipIf(process.platform === "win32")(
    "rejects blocked command in restricted mode",
    async () => {
      const result = await executeTool(
        "bash",
        { command: "rm -rf /" },
        tempDir,
        "restricted",
        allowedCommands,
        timeoutMs,
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("command not allowed");
    },
  );

  it.skipIf(process.platform === "win32")("strips ANSI colour codes from output", async () => {
    const result = await executeTool(
      "bash",
      { command: "echo -e '\\033[31mred\\033[39m plain'" },
      tempDir,
      "restricted",
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe("red plain");
  });

  it.skipIf(process.platform === "win32")("is killed when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    const result = await executeTool(
      "bash",
      { command: "sleep 5" },
      tempDir,
      "restricted",
      [...allowedCommands, "sleep"],
      10_000,
      false,
      controller.signal,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("cancelled");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not spawn when the signal is already aborted", async () => {
    const result = await executeTool(
      "bash",
      { command: "echo hi" },
      tempDir,
      "restricted",
      allowedCommands,
      timeoutMs,
      false,
      AbortSignal.abort(),
    );
    expect(result).toEqual({ success: false, output: "command cancelled" });
  });

  it("disabled in none mode", async () => {
    const result = await executeTool(
      "bash",
      { command: "echo hi" },
      tempDir,
      "none",
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("bash is disabled");
  });

  it.skipIf(process.platform === "win32")("appends warning in full mode", async () => {
    const result = await executeTool(
      "bash",
      { command: "echo hi" },
      tempDir,
      "full",
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("shell mode: full");
  });

  it.skipIf(process.platform === "win32")(
    "kills grandchild processes on timeout",
    { timeout: 15000 },
    async () => {
      // Spawn a bash command that forks a grandchild sleep process
      // The outer bash prints the grandchild PID then waits
      const result = await executeTool(
        "bash",
        { command: 'bash -c "sleep 60 & echo \\$!; wait"' },
        tempDir,
        "full",
        allowedCommands,
        500, // 500ms timeout — grandchild won't finish in time
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("timed out");

      // Extract the grandchild PID from stdout (printed before timeout killed the group)
      const pidMatch = result.output.match(/^(\d+)$/m);
      if (pidMatch) {
        const grandchildPid = parseInt(pidMatch[1], 10);
        // Give OS a moment to clean up
        await new Promise((r) => setTimeout(r, 200));
        // Verify grandchild is dead
        let alive: boolean;
        try {
          process.kill(grandchildPid, 0); // signal 0 = existence check
          alive = true;
        } catch {
          // ESRCH = process doesn't exist = success
          alive = false;
        }
        expect(alive).toBe(false);
      }
    },
  );
});

describe("unknown tool", () => {
  it("returns error for unknown tool", async () => {
    const result = await executeTool(
      "fake_tool",
      {},
      tempDir,
      shellMode,
      allowedCommands,
      timeoutMs,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("unknown tool");
  });
});
