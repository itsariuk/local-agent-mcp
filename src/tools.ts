// Tool executors and tool definitions for the local agent.
// All path operations routed through security.ts assertions.

import fs from "node:fs/promises";
import nodePath from "node:path";
import { spawn } from "node:child_process";
import type { OllamaToolDefinition } from "./ollama.js";
import {
  assertPathSafe,
  assertCommandAllowed,
  assertReadOnlyShell,
  buildSafeEnv,
  truncateOutput,
  type ShellMode,
} from "./security.js";

// ---------------------------------------------------------------------------
// Tool definitions (TOOL-05: meaningful descriptions for model tool selection)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: OllamaToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file at the given path. Returns the full file text. Use this to examine existing code, configs, or data files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to working directory",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file at the given path. Creates the file if it does not exist. Creates intermediate directories automatically. Use this to create or update code, configs, or data files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to working directory",
          },
          content: {
            type: "string",
            description: "The full content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_text",
      description:
        "Replace one exact occurrence of old_text with new_text in an existing file. old_text must match the file exactly, including whitespace, and must appear exactly once — include surrounding lines to make it unique. Prefer this over write_file when changing part of a file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to working directory",
          },
          old_text: {
            type: "string",
            description: "The exact text to replace; must occur exactly once",
          },
          new_text: {
            type: "string",
            description: "The text to put in its place",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List the contents of a directory with details: file name, type (file/dir), size in bytes, and last modified date. Use this to explore project structure before reading specific files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to working directory",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Execute a shell command and return its stdout and stderr. Commands are restricted to a safe allow-list by default: git, ls, cat, echo, grep, head, tail, wc, find, mkdir, cp, mv, touch, npm, node, python. Use this to run builds, tests, git operations, and explore the filesystem. Use replace_text or write_file for edits, not shell redirection. In read-only mode only inspection commands are allowed.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
        },
        required: ["command"],
      },
    },
  },
];

// Colour codes are noise (and tokens) for the model and the supervisor.
// Built from a char code: a literal escape in a regex trips no-control-regex.
const ANSI_COLOR = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

const WRITE_TOOLS = new Set(["write_file", "replace_text"]);

/** The tools offered to the model; read-only mode hides the write tools. */
export function toolDefinitions(readOnly: boolean): OllamaToolDefinition[] {
  return readOnly
    ? TOOL_DEFINITIONS.filter((t) => !WRITE_TOOLS.has(t.function.name))
    : TOOL_DEFINITIONS;
}

// ---------------------------------------------------------------------------
// Tool result type
// ---------------------------------------------------------------------------

export interface ToolResult {
  success: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Individual tool executors
// ---------------------------------------------------------------------------

async function readFile(args: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  const safePath = assertPathSafe(filePath, workingDir);
  const content = await fs.readFile(safePath, "utf-8");
  return { success: true, output: content };
}

async function writeFile(args: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  const content = String(args.content ?? "");
  const safePath = assertPathSafe(filePath, workingDir);
  await fs.mkdir(nodePath.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, content, "utf-8");
  const bytes = Buffer.byteLength(content, "utf-8");
  return { success: true, output: `wrote ${bytes} bytes to ${filePath}` };
}

async function replaceText(args: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  const oldText = String(args.old_text ?? "");
  const safePath = assertPathSafe(filePath, workingDir);
  if (oldText === "") {
    throw new Error("old_text must not be empty");
  }
  // Empty new_text is a valid deletion; a missing one is a malformed call
  if (typeof args.new_text !== "string") {
    throw new Error("new_text is required (use an empty string to delete)");
  }
  const newText = args.new_text;
  const content = await fs.readFile(safePath, "utf-8");
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new Error(`old_text not found in ${filePath}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `old_text has ${occurrences} occurrences in ${filePath}; add surrounding context to make it unique`,
    );
  }
  // Function form: a string replacement would interpret $& / $1 in newText
  await fs.writeFile(
    safePath,
    content.replace(oldText, () => newText),
    "utf-8",
  );
  return { success: true, output: `replaced 1 occurrence in ${filePath}` };
}

async function listDir(args: Record<string, unknown>, workingDir: string): Promise<ToolResult> {
  const dirPath = String(args.path ?? ".");
  const safePath = assertPathSafe(dirPath, workingDir);
  const entries = await fs.readdir(safePath, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries) {
    const entryPath = nodePath.join(safePath, entry.name);
    const stat = await fs.stat(entryPath);
    const typeChar = entry.isDirectory() ? "d" : "f";
    const modified = stat.mtime.toISOString();
    lines.push(`${typeChar} ${entry.name} ${stat.size}B ${modified}`);
  }
  return { success: true, output: lines.join("\n") };
}

async function bashExec(
  args: Record<string, unknown>,
  workingDir: string,
  shellMode: ShellMode,
  allowedCommands: readonly string[],
  timeoutMs: number,
  readOnly: boolean,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (shellMode === "none") {
    return { success: false, output: "bash is disabled (shell mode: none)" };
  }
  if (signal?.aborted) {
    return { success: false, output: "command cancelled" };
  }

  const command = String(args.command ?? "");

  if (readOnly) {
    assertReadOnlyShell(command); // analyze mode ignores AGENT_SHELL_MODE=full on purpose
  } else if (shellMode === "restricted") {
    assertCommandAllowed(command, allowedCommands);
  }

  const env = buildSafeEnv();

  return new Promise<ToolResult>((resolve) => {
    let timedOut = false;
    let cancelled = false;
    let stdout = "";
    let stderr = "";

    const isUnix = process.platform !== "win32";

    const child = spawn("bash", ["-c", command], {
      cwd: workingDir,
      env,
      ...(isUnix ? { detached: true } : {}),
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", () => {
      // handled in close
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      if (cancelled) {
        resolve({ success: false, output: "command cancelled" });
        return;
      }

      if (timedOut) {
        const seconds = Math.round(timeoutMs / 1000);
        resolve({
          success: false,
          output: `command timed out after ${seconds}s`,
        });
        return;
      }

      let output = truncateOutput((stdout + stderr).replace(ANSI_COLOR, ""));

      if (shellMode === "full") {
        output += "\n[shell mode: full — no restrictions applied]";
      }

      resolve({ success: code === 0, output });
    });

    // Kill the process group on Unix (children included), direct kill on Windows
    const kill = () => {
      if (isUnix && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill("SIGTERM");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workingDir: string,
  shellMode: ShellMode,
  allowedCommands: readonly string[],
  timeoutMs: number,
  readOnly = false,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    if (readOnly && WRITE_TOOLS.has(name)) {
      return { success: false, output: `${name} is not available in read-only mode` };
    }
    switch (name) {
      case "read_file":
        return await readFile(args, workingDir);
      case "write_file":
        return await writeFile(args, workingDir);
      case "replace_text":
        return await replaceText(args, workingDir);
      case "list_dir":
        return await listDir(args, workingDir);
      case "bash":
        return await bashExec(
          args,
          workingDir,
          shellMode,
          allowedCommands,
          timeoutMs,
          readOnly,
          signal,
        );
      default:
        return { success: false, output: `unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      success: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}
