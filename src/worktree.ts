// Git worktree lifecycle for implement-mode jobs. Git only — no agent knowledge.
// A worktree = HEAD + the user's uncommitted changes, committed as a base so the
// job's own changes are a plain `git diff --cached`.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Worktree {
  path: string; // absolute worktree root
  root: string; // the user's repo root
  relativeDir: string; // workingDir relative to root ("" when equal)
}

export interface CapturedDiff {
  patch: string;
  files: string[]; // `git diff --name-status` lines, e.g. "M\tsrc/x.ts"
}

// Works on machines with no global git identity; never reaches the user's branch
const GIT_IDENTITY = ["-c", "user.name=local-agent", "-c", "user.email=local-agent@localhost"];

// ---------------------------------------------------------------------------
// git runner (no shell: no quoting, no injection surface)
// ---------------------------------------------------------------------------

function runGit(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    // git may exit before stdin is written (rev-parse never reads it): EPIPE on
    // stdin is harmless, and an unhandled 'error' here would crash the server
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(input ?? "");
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createWorktree(workingDir: string, jobId: string): Promise<Worktree> {
  let root: string;
  try {
    root = (await runGit(workingDir, ["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    throw new Error(
      `blocked: ${workingDir} is not inside a git repository (implement mode needs one)`,
      { cause: err },
    );
  }

  // Outside the repo, or it would show up as untracked in the user's checkout
  const wtPath = path.join(os.tmpdir(), "local-agent-mcp", jobId);
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  await runGit(root, ["worktree", "add", "--detach", "-q", wtPath, "HEAD"]);

  try {
    await snapshotInto(root, wtPath);
  } catch (err) {
    // A half-built worktree is useless; do not leak it
    await removeWorktree(root, wtPath);
    throw err;
  }

  console.error(`[worktree] ${jobId} at ${wtPath}`);
  // realpath: `root` from git has symlinks resolved, so workingDir must too or
  // relativeDir would climb back out of the worktree into the real checkout
  const relativeDir = path.relative(root, await fs.realpath(workingDir));
  return { path: wtPath, root, relativeDir };
}

// Dependency dirs only. Linking every ignored dir (build/, dist/, coverage/)
// would let a build in the worktree write straight into the user's checkout.
const LINKED_DIRS = ["node_modules", ".venv", "venv", "vendor"];

/** HEAD + tracked edits + untracked files, committed as the worktree's base. */
async function snapshotInto(root: string, wtPath: string): Promise<void> {
  const patch = await runGit(root, ["diff", "HEAD", "--binary"]);
  if (patch.length > 0) {
    await runGit(wtPath, ["apply", "--whitespace=nowarn"], patch);
  }
  const untracked = (await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  for (const file of untracked) {
    const source = path.join(root, file);
    const target = path.join(wtPath, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Untracked symlinks are recreated, not followed: following one into a
    // directory (a hand-made node_modules link) would fail or copy a tree
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(source), target);
    else await fs.copyFile(source, target);
  }

  for (const name of LINKED_DIRS) {
    const source = path.join(root, name);
    const isDir = await fs.stat(source).then(
      (s) => s.isDirectory(),
      () => false,
    );
    const ignored =
      isDir &&
      (await runGit(root, ["check-ignore", "-q", name]).then(
        () => true,
        () => false,
      ));
    if (ignored) await fs.symlink(source, path.join(wtPath, name));
  }

  await runGit(wtPath, ["add", "-A"]);
  await runGit(wtPath, [
    ...GIT_IDENTITY,
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "local-agent base",
  ]);
}

/** The job's own changes relative to the snapshot base. */
export async function captureDiff(wtPath: string): Promise<CapturedDiff> {
  await runGit(wtPath, ["add", "-A"]);
  const files = (await runGit(wtPath, ["diff", "--cached", "--name-status"]))
    .trim()
    .split("\n")
    .filter(Boolean);
  const patch = await runGit(wtPath, ["diff", "--cached", "--binary"]);
  return { patch, files };
}

/** Best effort: a leftover worktree is reported, never fatal. */
export async function removeWorktree(root: string, wtPath: string): Promise<void> {
  try {
    await runGit(root, ["worktree", "remove", "--force", wtPath]);
  } catch (err) {
    console.error(
      `[worktree] failed to remove ${wtPath}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
