import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorktree, captureDiff, removeWorktree } from "../worktree.js";

const execFile = promisify(execFileCb);
const git = (cwd: string, ...args: string[]) =>
  execFile("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd }).then(
    (r) => r.stdout,
  );

let repo: string;
const created: string[] = [];

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "wt-repo-"));
  await git(repo, "init", "-q");
  await fs.writeFile(path.join(repo, "a.txt"), "a\n");
  await fs.mkdir(path.join(repo, "sub"));
  await fs.writeFile(path.join(repo, "sub", "b.txt"), "x\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "node_modules\n");
  await fs.mkdir(path.join(repo, "node_modules"));
  await fs.writeFile(path.join(repo, "node_modules", "dep"), "");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
});

afterEach(async () => {
  for (const wt of created.splice(0)) await removeWorktree(repo, wt);
  await fs.rm(repo, { recursive: true, force: true });
});

async function dirty() {
  await fs.writeFile(path.join(repo, "a.txt"), "a\nedited\n");
  await fs.writeFile(path.join(repo, "sub", "new.txt"), "new\n");
}

async function create(
  dir = repo,
  jobId = `t-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
) {
  const wt = await createWorktree(dir, jobId);
  created.push(wt.path);
  return wt;
}

describe("createWorktree", () => {
  it("snapshots tracked edits and untracked files into a base commit outside the repo", async () => {
    await dirty();
    const wt = await create();

    expect(wt.path.startsWith(repo)).toBe(false);
    expect(wt.root).toBe(await fs.realpath(repo).catch(() => repo));
    expect(await fs.readFile(path.join(wt.path, "a.txt"), "utf-8")).toBe("a\nedited\n");
    expect(await fs.readFile(path.join(wt.path, "sub", "new.txt"), "utf-8")).toBe("new\n");
    expect(await fs.readlink(path.join(wt.path, "node_modules"))).toBe(
      path.join(wt.root, "node_modules"),
    );
    expect((await git(wt.path, "status", "--porcelain")).trim()).toBe("");
    expect((await git(wt.path, "log", "--oneline")).trim().split("\n")).toHaveLength(2);
    // The user's checkout is untouched
    expect((await git(repo, "status", "--porcelain")).trimEnd().split("\n").sort()).toEqual([
      " M a.txt",
      "?? sub/new.txt",
    ]);
  });

  it("recreates an untracked symlink instead of following it", async () => {
    await fs.symlink(path.join(repo, "sub"), path.join(repo, "link"));
    const wt = await create();
    expect(await fs.readlink(path.join(wt.path, "link"))).toBe(path.join(repo, "sub"));
  });

  it("links only dependency dirs, not every ignored dir", async () => {
    await fs.appendFile(path.join(repo, ".gitignore"), "build\n");
    await fs.mkdir(path.join(repo, "build"));
    await fs.writeFile(path.join(repo, "build", "out.js"), "");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "ignore build");

    const wt = await create();

    await expect(fs.lstat(path.join(wt.path, "build"))).rejects.toThrow();
    expect((await fs.lstat(path.join(wt.path, "node_modules"))).isSymbolicLink()).toBe(true);
  });

  it("resolves a symlinked working dir so relativeDir stays inside the worktree", async () => {
    const link = path.join(os.tmpdir(), `wt-link-${Date.now()}`);
    await fs.symlink(repo, link);
    const wt = await create(path.join(link, "sub"));
    expect(wt.relativeDir).toBe("sub");
    await fs.unlink(link);
  });

  it("removes the worktree when the snapshot fails", async () => {
    await fs.writeFile(path.join(repo, "secret.txt"), "x");
    await fs.chmod(path.join(repo, "secret.txt"), 0o000);

    await expect(createWorktree(repo, `fail-${Date.now()}`)).rejects.toThrow();

    expect((await git(repo, "worktree", "list")).trim().split("\n")).toHaveLength(1);
    await fs.chmod(path.join(repo, "secret.txt"), 0o644);
  });

  it("works on a clean repo", async () => {
    const wt = await create();
    expect((await git(wt.path, "log", "--oneline")).trim().split("\n")).toHaveLength(2);
  });

  it("is blocked outside a git repository", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "wt-plain-"));
    await expect(createWorktree(plain, "x")).rejects.toThrow(
      /blocked: .* not inside a git repository/,
    );
    await fs.rm(plain, { recursive: true, force: true });
  });

  it("uses the whole repo when the working dir is a subdirectory", async () => {
    const wt = await create(path.join(repo, "sub"));
    expect(wt.relativeDir).toBe("sub");
    await fs.access(path.join(wt.path, "a.txt"));
  });
});

describe("captureDiff", () => {
  it("returns only the job's changes, and the patch applies to the user's tree", async () => {
    await dirty();
    const wt = await create();
    await fs.writeFile(path.join(wt.path, "a.txt"), "a\nedited\nworker\n");
    await fs.writeFile(path.join(wt.path, "worker.txt"), "w\n");
    await fs.rm(path.join(wt.path, "sub", "b.txt"));

    const { patch, files } = await captureDiff(wt.path);

    expect(files.sort()).toEqual(["A\tworker.txt", "D\tsub/b.txt", "M\ta.txt"]);
    expect(patch).toContain("+worker");
    expect(patch).toContain("deleted file mode");
    expect(await fs.readFile(path.join(repo, "a.txt"), "utf-8")).toBe("a\nedited\n");

    const patchFile = path.join(os.tmpdir(), `wt-${Date.now()}.patch`);
    await fs.writeFile(patchFile, patch);
    await expect(git(repo, "apply", "--check", patchFile)).resolves.toBeDefined();
    await fs.rm(patchFile);
  });

  it("is empty when the job changed nothing", async () => {
    const wt = await create();
    expect(await captureDiff(wt.path)).toEqual({ patch: "", files: [] });
  });
});

describe("removeWorktree", () => {
  it("deletes the directory and unregisters it", async () => {
    const wt = await create();
    await removeWorktree(repo, wt.path);
    created.pop();
    await expect(fs.access(wt.path)).rejects.toThrow();
    expect((await git(repo, "worktree", "list")).trim().split("\n")).toHaveLength(1);
  });
});
