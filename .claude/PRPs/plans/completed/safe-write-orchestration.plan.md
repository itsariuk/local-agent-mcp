# Plan: Safe Write Orchestration (Goal Doc Phase 3)

## Summary
Give `run_local_agent` a `mode`: `analyze` runs read-only against the checkout (no write tools, read-only shell), `implement` runs in a throwaway git worktree seeded with the user's uncommitted changes and returns a diff instead of touching the checkout, and `direct` is today's behaviour and stays the default. Along the way, close the shell allow-list hole where `ls; rm -rf x` passes because only the first token is checked.

Decisions taken with the user on 2026-09-21: `mode` defaults to `direct` (backward compatible; Phase 4's semantic tools will default to worktrees); a dirty checkout is **snapshotted** into the worktree rather than refused.

## User Story
As a Claude Code / Codex supervisor,
I want to run two implementation jobs in parallel and any number of analysis jobs without a worker ever modifying my checkout,
So that I can use both GPUs for writes and review each result as a diff before integrating it.

## Problem → Solution
Every job edits `AGENT_WORKING_DIR` in place; "read-only" is a prompt instruction, not an enforcement; two parallel write jobs collide; `ls; rm -rf` passes the allow-list.
→ Per-mode tool sets and shell profiles enforced in code; write jobs isolated in `git worktree`s with the diff captured and the worktree removed; every segment of a chained shell command checked.

## Metadata
- **Complexity**: Medium-Large
- **Source PRD**: `local-agent-mcp-dual-3090-orchestration-goal.md`
- **PRD Phase**: §28 "Phase 3 — Safe write orchestration" (§8, §9, §23). Phases 1-2 complete (`.claude/PRPs/reports/`).
- **Estimated Files**: 11 (2 created, 9 updated)

---

## UX Design

### Before
```
run_local_agent(prompt) ──> worker edits AGENT_WORKING_DIR directly
                             (any tool, any allowed command; parallel writers collide)
```

### After
```
run_local_agent(prompt, mode="analyze")   ──> checkout, read-only tools + read-only shell
run_local_agent(prompt, mode="implement") ──> git worktree <tmp>/local-agent-mcp/<job>
                                               = HEAD + your uncommitted changes (base commit)
                                               worker edits + runs tests there
                                              <── report + "files changed" + unified diff
                                               worktree removed (kept on failure, path reported)
run_local_agent(prompt)                    ──> unchanged ("direct")
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `run_local_agent` input | `prompt, model?, worker?` | + `mode?: "analyze" \| "implement" \| "direct"` (default `direct`) | additive |
| Header line | `[worker … \| … iterations]` | + `\| mode implement` | |
| `analyze` job | — | `write_file`/`replace_text` not offered to the model and refused if called; shell limited to a read-only list; `git` limited to read subcommands | overrides `AGENT_SHELL_MODE=full` |
| `implement` result | files edited in place | text report, then `--- changes (N files) ---`, `M src/x.ts` lines, then the unified diff; checkout untouched | diff clipped at 200 KB with a note |
| `implement` on a non-git dir | n/a | `Error: blocked: … is not inside a git repository` (`isError`) | goal doc §25 `blocked` |
| Failed `implement` job (loop throws) | n/a | worktree kept; error message includes its path | §24 `retain_worktrees_on_failure` |
| Chained shell commands (all modes, restricted) | only first token checked | every segment checked | `git status && rm -rf x` now rejected |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `src/index.ts` | 32-90 | Handler that gains `mode`; where the worktree lifecycle wraps `runAgentLoop` |
| P0 | `src/loop.ts` | 33-66, 104-113, 160-185 | `SYSTEM_PROMPT`, `runAgentLoop` options, where `TOOL_DEFINITIONS` and `executeTool` are called |
| P0 | `src/tools.ts` | 20-123, 205-215, 290-319 | tool definitions, `bashExec` entry, `executeTool` dispatch |
| P0 | `src/security.ts` | 35-68 | `DEFAULT_ALLOWED_COMMANDS`, `assertCommandAllowed` to extend |
| P1 | `src/pool.ts` | 60-70 | `run(job)` gives the job `(worker, jobId)` — `jobId` names the worktree |
| P1 | `src/__tests__/tools.test.ts` | 8-20, 230-260 | temp-dir setup; positional `executeTool` call shape used 23× |
| P1 | `src/__tests__/security.test.ts` | 65-130 | allow-list test style |
| P2 | `src/__tests__/server.e2e.test.ts` | 1-120 | mock Ollama + stdio client, reused for the implement-mode e2e |
| P2 | `src/__tests__/ollama.test.ts` | 1-25 | `listen` helper style |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Worktree snapshot flow | Proven 2026-09-21 in a scratch repo with git 2.55.0 (see Notes) | `worktree add --detach <path> HEAD` → `git diff HEAD --binary \| git -C wt apply --whitespace=nowarn` → copy `git ls-files --others --exclude-standard -z` → `git -C wt add -A && commit --allow-empty` → job → `git -C wt add -A && git diff --cached --binary` / `--name-status` → `git worktree remove --force wt`. Checkout stays untouched; an ignored `node_modules` symlink stays out of the diff. |

```
KEY_INSIGHT: `git worktree add` shares the object store; no clone, no extra disk beyond the checkout.
APPLIES_TO: Task 7
GOTCHA: The worktree must live OUTSIDE the repo, or it shows up as untracked in the user's checkout. Use os.tmpdir()/local-agent-mcp/<jobId>.

KEY_INSIGHT: Committing the snapshot as a base commit on the detached worktree makes "what the worker changed" a plain `git diff --cached` — and that patch applies to the user's dirty tree with `git apply`.
APPLIES_TO: Task 7
GOTCHA: The commit needs an identity; pass `-c user.name=local-agent -c user.email=local-agent@localhost` so it works on machines with no global git config. It never reaches the user's branch (detached HEAD in a removed worktree).

KEY_INSIGHT: Ignored directories (node_modules, .venv) are not in the worktree, so tests would fail. Symlink each top-level ignored dir that exists in the root.
APPLIES_TO: Task 7
GOTCHA: Only link entries that `git check-ignore -q <name>` accepts; otherwise the symlink lands in the diff.

KEY_INSIGHT: `execFile("git", [...])` (no shell) is the right primitive here — no quoting, no injection surface.
APPLIES_TO: Task 7
GOTCHA: Use `maxBuffer` ≥ 50 MB for the diff calls; the default 1 MB truncates large binary patches.
```

---

## Patterns to Mirror

### NAMING_CONVENTION
// SOURCE: src/pool.ts:1-2, 12-16
File-level comment stating the one thing the module does and what it deliberately does not; SCREAMING_SNAKE constants; PascalCase types.
```ts
// Worker pool — one job per worker at a time, FIFO queue for the rest.
// Health is probed at dispatch only: no timers, no background state.
```

### ERROR_HANDLING
// SOURCE: src/tools.ts:313-318, src/index.ts:79-90
Executors throw; `executeTool` converts to `{success:false}`. Handler catches everything and returns `isError: true` with `Error: <message>`.

### LOGGING_PATTERN
// SOURCE: src/pool.ts:86
```ts
        console.error(`[pool] worker ${worker.id} unhealthy at ${worker.host}`);
```
Worktree logs use `[worktree]`.

### SECURITY_ASSERTION_PATTERN
// SOURCE: src/security.ts:56-68
Pure function, throws a short user-facing message, no dependencies.
```ts
export function assertCommandAllowed(command: string, allowList: readonly string[]): void {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("command not allowed (use AGENT_ALLOWED_COMMANDS to add)");
  }
  const firstToken = trimmed.split(/\s+/)[0]!;
  if (!allowList.includes(firstToken)) {
    throw new Error("command not allowed (use AGENT_ALLOWED_COMMANDS to add)");
  }
}
```

### TEST_STRUCTURE
// SOURCE: src/__tests__/tools.test.ts:8-20
```ts
let tempDir: string;
const shellMode = "restricted" as const;
const allowedCommands = DEFAULT_ALLOWED_COMMANDS;
const timeoutMs = 5000;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tools-test-"));
  await fs.writeFile(path.join(tempDir, "test.txt"), "hello world", "utf-8");
});
```
Git-based tests: `execFile("git", ["init", "-q"], { cwd })` then `["-c","user.email=t@t","-c","user.name=t","commit","-qm","base"]`.

---

## Files to Change

| File | Action | Responsibility |
|---|---|---|
| `src/worktree.ts` | CREATE | `createWorktree(root, jobId)`, `captureDiff(wt)`, `removeWorktree(root, wt)` — git only, no agent knowledge |
| `src/__tests__/worktree.test.ts` | CREATE | Snapshot, diff, cleanup, non-repo, ignored-dir link |
| `src/security.ts` | UPDATE | Segment-aware `assertCommandAllowed`; `READ_ONLY_COMMANDS`; `assertReadOnlyGit` |
| `src/tools.ts` | UPDATE | `toolDefinitions(readOnly)`; `executeTool` refuses write tools when read-only |
| `src/loop.ts` | UPDATE | `readOnly` option: filtered tools, analysis system prompt, forwards flag |
| `src/index.ts` | UPDATE | `mode` arg; per-mode shell profile; worktree lifecycle; result assembly |
| `src/__tests__/security.test.ts` | UPDATE | chained commands, read-only list, git subcommands |
| `src/__tests__/tools.test.ts` | UPDATE | read-only refusals |
| `src/__tests__/loop.test.ts` | UPDATE | read-only tool list + prompt |
| `src/__tests__/server.e2e.test.ts` | UPDATE | implement-mode e2e in a temp git repo |
| `README.md`, `CLAUDE.md` | UPDATE | modes, diff workflow, parallel-writes rule now enforced |

## NOT Building

- Changing the default mode. `direct` stays until Phase 4's `local_implement` exists.
- `review` mode — identical to `analyze` for enforcement purposes; Phase 4 names it.
- Applying the diff for the supervisor, branches per job, `git commit` in the worktree, auto-merge (§31).
- Argument-pattern inspection beyond chaining/redirection (`python -c`, `node -e` can still write in `direct`/`implement`; in `analyze` they are not on the read-only list at all).
- Symlink-escape checks on `assertPathSafe` (§22) — separate, small, but not this phase.
- Per-job log directories (Phase 6). Worktree paths are reported in the result on failure only.
- A config knob for the worktree location or for which ignored dirs get linked — `os.tmpdir()` and "every top-level ignored entry" until someone needs otherwise.
- `include_uncommitted=false`. The snapshot is always taken.

---

## Step-by-Step Tasks

### Task 0: Branch and baseline
- **ACTION**: `git checkout -b feat/safe-write-orchestration` from `main`; `npm test`.
- **VALIDATE**: 148 pass.

### Task 1: Failing security tests
- **ACTION**: Extend `src/__tests__/security.test.ts`.
- **IMPLEMENT**: In `describe("assertCommandAllowed")` add: `"ls; rm -rf x"`, `"git status && rm x"`, `"ls || rm x"`, `"cat a | rm x"`, `"ls\nrm x"`, `"echo $(rm x)"`, "echo \`rm x\`" each throw with `DEFAULT_ALLOWED_COMMANDS`; `"grep -r foo . | head"` and `"ls && git status"` do not throw. New `describe("READ_ONLY_COMMANDS")`: contains no `mkdir cp mv touch npm node python`; contains `git`. New `describe("assertReadOnlyShell")`: allows `git status`, `git diff HEAD`, `git log --oneline`, `git show HEAD:src/x.ts`, `git ls-files`, `git grep foo`, `git blame f`, `git rev-parse HEAD`; rejects `git commit -m x`, `git checkout .`, `git reset --hard`, `git stash`, `git push`, `git`; rejects `ls > out.txt`, `cat a >> b`, `cat < x` is fine (allow), `echo hi | tee f`; rejects `npm test`, `node -e 1`, `python -c 1`.
- **MIRROR**: TEST_STRUCTURE / existing describe blocks.
- **VALIDATE**: new cases fail.

### Task 2: Implement shell profiles
- **ACTION**: Update `src/security.ts`.
- **IMPLEMENT**:
  ```ts
  // Split on shell control operators so every command in a chain is checked.
  // Quoted operators are split too — this errs on the side of rejecting.
  const COMMAND_SEPARATORS = /\|\|?|&&|;|\n/;
  const COMMAND_SUBSTITUTION = /\$\(|`/;

  export function assertCommandAllowed(command: string, allowList: readonly string[]): void {
    if (COMMAND_SUBSTITUTION.test(command)) {
      throw new Error("command not allowed (command substitution is not permitted)");
    }
    const segments = command.split(COMMAND_SEPARATORS).map((s) => s.trim());
    if (segments.some((s) => s.length === 0)) {
      throw new Error("command not allowed (use AGENT_ALLOWED_COMMANDS to add)");
    }
    for (const segment of segments) {
      const firstToken = segment.split(/\s+/)[0]!;
      if (!allowList.includes(firstToken)) {
        throw new Error("command not allowed (use AGENT_ALLOWED_COMMANDS to add)");
      }
    }
  }

  // SAFE-08: read-only shell profile (analyze mode)
  export const READ_ONLY_COMMANDS: readonly string[] = [
    "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "echo", "git", "diff", "sort", "uniq",
  ] as const;

  const READ_ONLY_GIT = new Set([
    "status", "diff", "log", "show", "ls-files", "grep", "blame", "rev-parse", "branch", "tag", "describe",
  ]);
  const REDIRECT_OR_TEE = /(^|[^<])>|\btee\b/;

  /** Analyze-mode shell: read-only allow-list, read-only git subcommands, no output redirection. */
  export function assertReadOnlyShell(command: string): void {
    assertCommandAllowed(command, READ_ONLY_COMMANDS);
    if (REDIRECT_OR_TEE.test(command)) {
      throw new Error("command not allowed in analyze mode (no output redirection)");
    }
    for (const segment of command.split(COMMAND_SEPARATORS)) {
      const [cmd, sub] = segment.trim().split(/\s+/);
      if (cmd === "git" && !(sub && READ_ONLY_GIT.has(sub))) {
        throw new Error(`command not allowed in analyze mode (git ${sub ?? ""} is not read-only)`.trim());
      }
    }
  }
  ```
- **GOTCHA**: `"ls && git status"` must pass — an empty segment check only fires on a leading/trailing/double operator. `2>&1` contains `>`; `REDIRECT_OR_TEE` `[^<]>` still matches it — accept that analyze mode forbids `2>&1` too (stderr is captured anyway). `find -delete` and `find -exec` are write paths: add `if (/\bfind\b.*(-delete|-exec|-ok)/.test(command)) throw` in `assertReadOnlyShell`.
- **VALIDATE**: security tests green; all existing tests still green (`"git --help"` style cases unaffected).

### Task 3: Failing tool tests for read-only mode
- **ACTION**: Extend `src/__tests__/tools.test.ts`.
- **IMPLEMENT**: `describe("read-only mode")`: `executeTool("write_file", {...}, tempDir, shellMode, allowedCommands, timeoutMs, true)` → `success:false`, output contains `"read-only"`, file not created; same for `replace_text`; `read_file` still works; `bash` with `"echo hi > f"` → fails, `f` not created; `bash` with `"npm --version"` → fails (not on read-only list); `bash` with `"echo hi"` → succeeds. `describe("toolDefinitions")`: `toolDefinitions(true)` has 3 entries and no `write_file`/`replace_text`; `toolDefinitions(false)` equals `TOOL_DEFINITIONS`.
- **VALIDATE**: fails to compile / fails.

### Task 4: Implement read-only tools
- **ACTION**: Update `src/tools.ts`.
- **IMPLEMENT**:
  - `const WRITE_TOOLS = new Set(["write_file", "replace_text"]);`
  - `export function toolDefinitions(readOnly: boolean): OllamaToolDefinition[] { return readOnly ? TOOL_DEFINITIONS.filter((t) => !WRITE_TOOLS.has(t.function.name)) : TOOL_DEFINITIONS; }`
  - `executeTool(..., timeoutMs: number, readOnly = false)`: first line of the `try`: `if (readOnly && WRITE_TOOLS.has(name)) return { success: false, output: \`${name} is not available in read-only mode\` };`
  - `bashExec` gains `readOnly` param; replace the restricted check with:
    ```ts
    if (readOnly) {
      assertReadOnlyShell(command); // analyze mode ignores AGENT_SHELL_MODE=full on purpose
    } else if (shellMode === "restricted") {
      assertCommandAllowed(command, allowedCommands);
    }
    ```
    but keep the `shellMode === "none"` early return above both.
- **MIRROR**: ERROR_HANDLING.
- **GOTCHA**: The `bash` tool description mentions the default allow-list; append " In read-only mode only inspection commands are allowed." Keep `TOOL_DEFINITIONS` exported — `tools.test.ts:23` asserts its length is 5 and parser tests import nothing from it.
- **VALIDATE**: tools tests green.

### Task 5: Loop read-only option (test first)
- **ACTION**: Add to `src/__tests__/loop.test.ts`, then `src/loop.ts`.
- **IMPLEMENT**: Tests: with `readOnly: true`, `chat.mock.calls[0][1].tools` has 3 entries; the system message content contains `"read-only"`; a native `write_file` tool call yields a step whose output contains `"read-only"` and the file is not written. Loop: option `readOnly?: boolean` (default false); `const tools = toolDefinitions(readOnly)` used in both chat calls; `executeTool(..., timeoutMs, readOnly)`; system prompt:
  ```ts
  const ANALYZE_PROMPT = [
    "You are a read-only repository analyst completing one bounded investigation for a supervisor.",
    "You cannot modify files; only inspection commands are available.",
    "Rules:",
    "- Answer only the delegated question. Do not broaden scope.",
    "- Use tools to gather evidence. Never invent file contents or claim to have run something you did not run.",
    "- Cite file paths and line numbers for every finding.",
    "When finished, reply with plain text and no tool call: findings with evidence, concise conclusions, and anything uncertain.",
  ].join("\n");
  ```
  and `{ role: "system", content: readOnly ? ANALYZE_PROMPT : SYSTEM_PROMPT }`.
- **VALIDATE**: loop tests green.

### Task 6: Failing worktree tests
- **ACTION**: Create `src/__tests__/worktree.test.ts`.
- **IMPLEMENT**: helper `initRepo()` → temp dir with `git init`, `a.txt`, `sub/b.txt`, `.gitignore` containing `node_modules`, a `node_modules/dep` file, one commit. Cases:
  1. **Snapshot**: dirty the repo (edit `a.txt`, add untracked `sub/new.txt`); `const wt = await createWorktree(repo, "job1")` → `wt.path` is outside `repo`, contains the edited `a.txt` and `sub/new.txt`; `node_modules` inside `wt.path` is a symlink to the repo's; `git -C wt status --porcelain` is empty (everything committed as base); repo's own `git status --porcelain` unchanged.
  2. **Diff**: in the worktree edit `a.txt`, add `worker.txt`, delete `sub/b.txt`; `captureDiff(wt.path)` → `{ patch, files }` where `files` equals `["M\ta.txt", "D\tsub/b.txt", "A\tworker.txt"]` (or sorted equivalent) and `patch` contains `+worker` and `deleted file mode`; the repo's `a.txt` still has only the user's edit.
  3. **Diff applies to the user's tree**: `git -C repo apply --check` with the patch written to a temp file succeeds.
  4. **Empty diff**: untouched worktree → `patch === ""`, `files` empty.
  5. **Remove**: `removeWorktree(repo, wt.path)` → directory gone, `git worktree list` shows one entry.
  6. **Clean repo**: no dirty state → works, base commit still created (`git -C wt log --oneline | wc -l` is 2).
  7. **Not a repo**: `createWorktree(plainTempDir, "x")` rejects with `/not inside a git repository/`.
  8. **Subdirectory as working dir**: `createWorktree(path.join(repo, "sub"), "x")` → worktree of the whole repo, `wt.relativeDir === "sub"`.
- **VALIDATE**: fails — module missing.

### Task 7: Implement `worktree.ts`
- **ACTION**: Create `src/worktree.ts`.
- **IMPLEMENT**:
  ```ts
  // Git worktree lifecycle for implement-mode jobs. Git only — no agent knowledge.
  // A worktree = HEAD + the user's uncommitted changes, committed as a base so the
  // job's own changes are a plain `git diff --cached`.

  import { execFile as execFileCb } from "node:child_process";
  import { promisify } from "node:util";
  import fs from "node:fs/promises";
  import os from "node:os";
  import path from "node:path";

  const execFile = promisify(execFileCb);
  const GIT_IDENTITY = ["-c", "user.name=local-agent", "-c", "user.email=local-agent@localhost"];
  const MAX_BUFFER = 64 * 1024 * 1024;

  export interface Worktree {
    path: string;        // absolute worktree root
    relativeDir: string; // workingDir relative to repo root ("" when equal)
    root: string;        // user's repo root
  }

  async function git(cwd: string, args: string[], input?: string): Promise<string> {
    const { stdout } = await execFile("git", args, { cwd, maxBuffer: MAX_BUFFER, ...(input !== undefined && { input }) } as never);
    return stdout;
  }
  ```
  (`execFile` with `input` needs the callback form + stdin write, or `spawn`; simplest: `spawn("git", args, {cwd})`, write `input` to stdin, collect stdout, reject on non-zero exit with stderr in the message. Write one `runGit(cwd, args, input?)` on `spawn` and use it everywhere.)

  `createWorktree(workingDir, jobId)`:
  1. `root = (await runGit(workingDir, ["rev-parse", "--show-toplevel"])).trim()` — on failure throw `Error(\`blocked: ${workingDir} is not inside a git repository (implement mode needs one)\`)`.
  2. `wtPath = path.join(os.tmpdir(), "local-agent-mcp", jobId)`; `fs.mkdir(dirname, {recursive:true})`.
  3. `runGit(root, ["worktree", "add", "--detach", "-q", wtPath, "HEAD"])`.
  4. `patch = await runGit(root, ["diff", "HEAD", "--binary"])`; if non-empty `runGit(wtPath, ["apply", "--whitespace=nowarn"], patch)`.
  5. `untracked = (await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)`; for each: `fs.mkdir(dirname)`, `fs.copyFile(root/f, wt/f)`.
  6. For each entry of `fs.readdir(root)`: if `runGit(root, ["check-ignore", "-q", name])` succeeds and it is a directory → `fs.symlink(root/name, wt/name)`.
  7. `runGit(wtPath, ["add", "-A"])`; `runGit(wtPath, [...GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "local-agent base"])`.
  8. `console.error(\`[worktree] ${jobId} at ${wtPath}\`)`; return `{ path: wtPath, root, relativeDir: path.relative(root, path.resolve(workingDir)) }`.

  `captureDiff(wtPath)`: `runGit(wt, ["add", "-A"])`; `files = (await runGit(wt, ["diff", "--cached", "--name-status"])).trim().split("\n").filter(Boolean)`; `patch = await runGit(wt, ["diff", "--cached", "--binary"])`; return `{ patch, files }`.

  `removeWorktree(root, wtPath)`: `runGit(root, ["worktree", "remove", "--force", wtPath])`; swallow errors but log `[worktree] failed to remove …`.
- **MIRROR**: NAMING_CONVENTION, LOGGING_PATTERN.
- **GOTCHA**: `check-ignore -q` exits 1 for not-ignored — treat non-zero as "not ignored", not as an error. `--exclude-standard` already skips ignored files, so the copy loop never copies `node_modules`. Use `-z` for untracked paths (filenames with spaces/newlines). `worktree remove --force` is needed because the base commit made the tree dirty from git's point of view.
- **VALIDATE**: worktree tests green; `npm run lint` (no `console.log`).

### Task 8: Wire `mode` into the handler
- **ACTION**: Update `src/index.ts`.
- **IMPLEMENT**:
  - `mode: z.enum(["analyze", "implement", "direct"]).optional().describe("analyze: read-only against the checkout. implement: edits in an isolated git worktree seeded with your uncommitted changes; returns a diff, never touches the checkout. direct (default): edits the checkout in place.")`.
  - Description: replace the parallel-writes sentence with "Parallel implement/analyze calls are safe; do not run two direct calls that modify files at the same time."
  - Inside `pool.run`:
    ```ts
    const readOnly = mode === "analyze";
    const wt = mode === "implement" ? await createWorktree(config.workingDir, jobId) : undefined;
    const workingDir = wt ? path.join(wt.path, wt.relativeDir) : config.workingDir;
    let result: AgentResult;
    try {
      result = await runAgentLoop({ ...same as now..., workingDir, readOnly });
    } catch (err) {
      // keep the worktree for inspection; say where it is
      throw wt ? new Error(`${err instanceof Error ? err.message : String(err)} (worktree kept at ${wt.path})`, { cause: err }) : err;
    }
    let text = formatAgentResult(result, config.maxIterations, { ..., mode: mode ?? "direct" });
    if (wt) {
      const { patch, files } = await captureDiff(wt.path);
      text += formatDiff(patch, files);
      await removeWorktree(wt.root, wt.path);
    }
    return text;
    ```
  - `formatDiff` (in `loop.ts` next to `formatAgentResult`, exported, tested): `""` when `files` is empty except `"\n\n[no files changed]"`; otherwise `\n\n--- changes (${files.length} files) ---\n${files.join("\n")}\n\n${patch}` with `patch` clipped to `MAX_DIFF_CHARS = 200_000` plus `\n[diff truncated: N more chars; re-run with a narrower task]`.
  - `RunInfo` gains `mode: string`; header becomes `[worker gpu0 | m | job x | 1.2s | 3 iterations | mode implement]`. Update the header test.
- **GOTCHA**: `createWorktree` must run **inside** `pool.run`'s job so the worker slot is held while the worktree exists — and its `jobId` is the pool's. Blocked errors from `createWorktree` propagate through the existing catch → `isError`. Import `path` from `node:path`.
- **VALIDATE**: `npm run typecheck && npm run lint && npm run build`; loop tests green.

### Task 9: E2E implement + analyze
- **ACTION**: Extend `src/__tests__/server.e2e.test.ts`.
- **IMPLEMENT**: make `tempDir` a git repo in `beforeAll` (init, `a.txt`, commit, then dirty it with an untracked `u.txt`). Mock Ollama gains a scripted mode: if the request's last user/tool message history has no tool result yet, reply with a native `write_file` tool call for `{path:"worker.txt", content:"w"}`; otherwise reply `"done"`. Tests:
  - **implement**: `run_local_agent({prompt:"x", mode:"implement"})` → text contains `mode implement`, `--- changes (1 files) ---`, `A\tworker.txt`, `+w`; `tempDir/worker.txt` does **not** exist; `u.txt` still exists; `git -C tempDir status --porcelain` unchanged; `git worktree list` in tempDir has 1 entry.
  - **analyze**: `mode:"analyze"` with the same scripted call → text contains `not available in read-only mode`; no file written.
  - **direct**: default → `tempDir/worker.txt` exists (then delete it).
  - **blocked**: spawn is per-suite, so test via a second `AGENT_WORKING_DIR`? Simpler: point the whole suite's `AGENT_WORKING_DIR` at the git repo and test "not a repo" only in the unit test (Task 6 case 7).
- **GOTCHA**: The mock must key on message history, not a counter, because three tools/call requests hit it. `worker.txt` in direct mode is created in the repo; remove it before the status assertion of later tests, or order tests implement → analyze → direct.
- **VALIDATE**: e2e green 3× in a row.

### Task 10: Docs
- **ACTION**: Update `README.md`, `CLAUDE.md`.
- **IMPLEMENT**: README "Execution modes" section (table of the three modes: tools available, shell profile, where it runs, what comes back), the diff workflow (`git apply` the returned patch, or paste it to the supervisor), note that worktrees live under the OS temp dir and are kept on failure. Configuration: no new env vars. Troubleshooting: "blocked: … not inside a git repository". CLAUDE.md: rule 8 becomes "Use `mode: \"implement\"` for parallel file-modifying tasks; only `direct` mode jobs must not run in parallel"; add "Use `mode: \"analyze\"` for exploration and review — it is enforced read-only"; delegation template gains `mode`.
- **VALIDATE**: `grep -rn "192\.168" README.md CLAUDE.md src .claude/PRPs` empty.

### Task 11: Full validation + live check
- **ACTION**: Validation Commands, then Manual Validation.

---

## Testing Strategy

### Unit Tests

| Test | Input | Expected Output | Edge Case? |
|---|---|---|---|
| chained command | `ls; rm -rf x` | rejected | yes (security) |
| substitution | `` echo `rm x` `` | rejected | yes |
| chained allowed | `ls && git status` | allowed | |
| read-only git | `git commit`, `git reset --hard`, `git` | rejected | yes |
| redirection | `ls > f`, `echo x \| tee f` | rejected in analyze | yes |
| find write | `find . -delete` | rejected in analyze | yes |
| write tool in read-only | `write_file` | refused, file absent | core |
| tool list read-only | — | 3 tools | |
| worktree snapshot | dirty repo | edits + untracked present, base committed | core |
| worktree diff | worker edits | patch + name-status, applies to user tree | core |
| worktree empty diff | no edits | `""`, `[]` | yes |
| worktree remove | — | gone from `worktree list` | |
| worktree non-repo | plain dir | `blocked: …` | yes |
| worktree subdir | `repo/sub` | `relativeDir === "sub"` | yes |
| formatDiff clip | 300 KB patch | truncated note | yes |
| e2e implement | scripted write | diff returned, checkout untouched | core |

### Edge Cases Checklist
- [x] Empty input — empty diff; empty command segments
- [x] Maximum size — diff clip at 200 KB; `maxBuffer` 64 MB on git calls
- [x] Invalid types — `mode` validated by zod enum
- [x] Concurrent access — two implement jobs get separate worktrees (jobId is unique per pool job); covered by e2e running two implement calls in parallel if time allows, else by construction
- [x] Permission denied — non-repo → blocked; write tools in analyze → refused
- [ ] Network failure — n/a (git is local)

---

## Validation Commands

### Static Analysis
```bash
npm run typecheck && npm run lint
```

### Unit Tests
```bash
npx vitest run src/__tests__/security.test.ts src/__tests__/tools.test.ts src/__tests__/loop.test.ts src/__tests__/worktree.test.ts
```

### Full Test Suite
```bash
npm test && npm run build
```
EXPECT: 148 baseline + new pass; e2e stable across 3 runs

### Manual Validation
Live endpoint is in project memory (`ollama-gpu-host`). Use a scratch **git** copy of the repo with a deliberate uncommitted edit as `AGENT_WORKING_DIR`.
- [ ] `mode:"analyze"`, prompt "Find every call site of assertPathSafe and report file:line" → findings with line numbers; stderr shows no write tools were offered; try a prompt that asks it to "fix" something → report says the tool is read-only, checkout unchanged.
- [ ] `mode:"implement"`, prompt "Using replace_text, change the default AGENT_TIMEOUT_SECONDS in src/config.ts from 120 to 90. Run npm test and report." → result has `mode implement`, `M\tsrc/config.ts`, a one-hunk diff; the scratch checkout's `git status` shows only the pre-existing edit; `ls $(node -e 'console.log(require("os").tmpdir())')/local-agent-mcp` is empty afterwards; `git apply` of the returned patch onto the scratch copy succeeds; the worker's `npm test` ran inside the worktree (node_modules symlink worked).
- [ ] Two `implement` jobs in parallel (one worker → they queue, but each still gets its own worktree): both return diffs; no cross-contamination.
- [ ] Default mode: unchanged behaviour from Phase 2.

---

## Acceptance Criteria
(goal doc §27 items this phase closes)
- [ ] Analysis jobs are enforced read-only
- [ ] Implementation jobs run in isolated git worktrees
- [ ] Two write jobs cannot corrupt each other's checkout
- [ ] Main user's working tree is never silently modified by a delegated implementation (`implement`)
- [ ] Final result contains concise summary + changed files + diff
- [ ] Existing `run_local_agent` usage remains compatible (`direct` default)
- [ ] typecheck, lint, test, build pass

## Completion Checklist
- [ ] Every segment of a chained shell command is checked in restricted mode
- [ ] Analyze mode ignores `AGENT_SHELL_MODE=full`
- [ ] Worktrees live outside the repo and are removed on success, kept and reported on failure
- [ ] No git identity assumptions (explicit `-c user.*`)
- [ ] No real hostnames/IPs in committed files
- [ ] README + CLAUDE.md updated; delegation template shows `mode`

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Segment splitting rejects legitimate commands with `;`/`&&` inside quotes (e.g. `grep "a;b"`) | Medium | Low | Errs toward rejection; the model gets a clear error and can rephrase. Note in README. |
| Large repos: copying untracked files or symlinking many ignored dirs is slow | Low | Low | Only untracked non-ignored files are copied; ignored dirs are symlinked, not copied |
| Worker runs `npm install` in the worktree → writes through the `node_modules` symlink into the user's real one | Medium | Medium | Document; `npm` is on the default allow-list by design. Phase 4 can drop `npm install` via argument inspection. |
| Job killed mid-run (server crash) leaves a worktree registered | Low | Low | `git worktree prune` on server start is a one-liner if it becomes a problem; not built now |
| A test in the worktree writes outside it (e.g. to `$HOME`) | Low | Low | Unchanged from today; sandboxing is §22 "later" |
| Supervisor forgets to apply the diff and thinks the change landed | Medium | Medium | Result header says `mode implement`; README explains the apply step; Phase 4 tool descriptions will say it again |

## Notes
- Proven in a scratch repo (git 2.55.0) before writing this plan: worktree add → apply dirty diff → copy untracked → symlink ignored `node_modules` → base commit → worker edits → `diff --cached --binary` + `--name-status` → `worktree remove --force`. The user's checkout was untouched and the ignored symlink did not appear in the diff.
- Not verified: `check-ignore` behaviour on nested ignore files (only top-level entries are linked, so it should not matter); `spawn`-based `runGit` with stdin input is standard but untested here.
- The `assertCommandAllowed` fix changes behaviour for all modes (restricted): previously chained commands slipped through. That is a security fix, not a regression — mention it in the commit message.
- `direct` mode is now the only way a worker touches the checkout; Phase 4 should make `local_implement` worktree-only and consider deprecating `direct`.
