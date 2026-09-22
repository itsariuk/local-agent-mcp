/**
 * Security module -- pure functions for path validation, command allow-listing,
 * environment sanitization, and output truncation.
 *
 * Every tool executor routes through these functions.
 * No external dependencies beyond node:path and node:process.
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// SAFE-01: Path validation
// ---------------------------------------------------------------------------

/**
 * Assert that `targetPath` resolves to a location inside `root`.
 * Returns the resolved absolute path on success; throws on violation.
 *
 * Uses `root + path.sep` prefix check to prevent `/project-evil/` matching `/project`.
 */
export function assertPathSafe(targetPath: string, root: string): string {
  const resolved = path.resolve(root, targetPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("path not allowed (use AGENT_ALLOWED_PATHS to grant access)");
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// SAFE-02 / SAFE-03: Command allow-list
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  "git",
  "ls",
  "cat",
  "echo",
  "grep",
  "head",
  "tail",
  "wc",
  "find",
  "mkdir",
  "cp",
  "mv",
  "touch",
  "npm",
  "npx",
  "node",
  "python",
] as const;

// Split on shell control operators so every command in a chain is checked.
// A lone `&` (background) counts too, except inside `>&`/`<&` descriptor
// redirects. An operator escaped by an odd run of backslashes (`grep "a\|b"`,
// `find -exec {} \;`) is never a separator; `\\|` is an escaped backslash
// followed by a live pipe. Quoted operators are still split — this errs on the
// side of rejecting.
const COMMAND_SEPARATORS = /(?<!(?<!\\)(?:\\\\)*\\)(?:\|\|?|&&|(?<![<>])&|;)|\n/;
// `$(...)`, backticks, and process substitution `<(...)` / `>(...)`
const COMMAND_SUBSTITUTION = /\$\(|`|[<>]\(/;

/**
 * Assert that the first token of every command segment is in `allowList`.
 * Extracts the first whitespace-delimited token to prevent prefix attacks
 * (e.g. "gitevil" is not "git").
 */
export function assertCommandAllowed(command: string, allowList: readonly string[]): void {
  if (COMMAND_SUBSTITUTION.test(command)) {
    throw new Error("command not allowed (command substitution is not permitted)");
  }
  const segments = command.split(COMMAND_SEPARATORS).map((s) => s.trim());
  for (const segment of segments) {
    const firstToken = segment.split(/\s+/)[0]!;
    if (firstToken.length === 0 || !allowList.includes(firstToken)) {
      throw new Error("command not allowed (use AGENT_ALLOWED_COMMANDS to add)");
    }
  }
}

// ---------------------------------------------------------------------------
// SAFE-08: Read-only shell profile (analyze mode)
// ---------------------------------------------------------------------------

export const READ_ONLY_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "echo",
  "git",
  "diff",
  "sort",
  "uniq",
] as const;

const READ_ONLY_GIT = new Set([
  "status",
  "diff",
  "log",
  "show",
  "ls-files",
  "grep",
  "blame",
  "rev-parse",
  "describe",
  "show-ref",
]); // no `branch`/`tag`: read-only only without positional args, not worth parsing

// Flags and forms through which the "read-only" commands write or execute
const WRITE_PATTERNS: readonly RegExp[] = [
  /(^|[^<])>(?!&[0-9]|\/dev\/null)/, // `>`/`>>` redirection; `2>&1` and `>/dev/null` are fine
  /\btee\b/,
  /--output\b/, // git log/diff/show, sort
  /\bfind\b.*\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/,
  /\bsort\b.*\s(-o|--compress-program)\b/,
  /\brg\b.*\s--pre\b/,
];

/** Analyze-mode shell: read-only allow-list, read-only git subcommands, no output redirection. */
export function assertReadOnlyShell(command: string): void {
  assertCommandAllowed(command, READ_ONLY_COMMANDS);
  if (WRITE_PATTERNS.some((p) => p.test(command))) {
    throw new Error("command not allowed in analyze mode (no output redirection or file writes)");
  }
  for (const segment of command.split(COMMAND_SEPARATORS)) {
    const [cmd, sub] = segment.trim().split(/\s+/);
    if (cmd === "git" && !(sub !== undefined && READ_ONLY_GIT.has(sub))) {
      throw new Error(`command not allowed in analyze mode (git ${sub ?? ""} is not read-only)`);
    }
  }
}

// ---------------------------------------------------------------------------
// SAFE-05: Safe subprocess environment
// ---------------------------------------------------------------------------

export const ALLOWED_ENV_KEYS = ["PATH", "HOME", "USER", "LANG"] as const;

/**
 * Build a sanitized environment object containing only allowed keys.
 * Returns a fresh object -- no reference to `process.env`.
 */
export function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// SAFE-06: Output truncation
// ---------------------------------------------------------------------------

export const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

/**
 * If `output` exceeds MAX_OUTPUT_BYTES, truncate and append a notice.
 */
export function truncateOutput(output: string): string {
  if (Buffer.byteLength(output) <= MAX_OUTPUT_BYTES) {
    return output;
  }
  // Slice conservatively within byte budget
  let end = output.length;
  while (Buffer.byteLength(output.slice(0, end)) > MAX_OUTPUT_BYTES) {
    end = Math.floor(end * 0.9);
  }
  // Binary-search upward for tighter fit
  let lo = end;
  let hi = output.length;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (Buffer.byteLength(output.slice(0, mid)) <= MAX_OUTPUT_BYTES) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return output.slice(0, lo) + "\n[output truncated: exceeded 1MB limit]";
}

// ---------------------------------------------------------------------------
// SAFE-07: Shell mode
// ---------------------------------------------------------------------------

export type ShellMode = "restricted" | "full" | "none";

/**
 * Returns true when shell mode is "restricted" (default safe mode).
 */
export function isShellModeRestricted(mode: ShellMode): boolean {
  return mode === "restricted";
}
