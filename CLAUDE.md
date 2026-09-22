# Project Instructions

## Local Agent Delegation

This project has local-worker MCP tools connected (`local_analyze`, `local_implement`,
`local_review`, `run_local_agent`). Use them to offload mechanical coding work to local
models, reserving Claude for reasoning, orchestration, and judgment.

---

### When to Delegate (always prefer local agent for these)

| Task type | Examples |
|-----------|---------|
| Implement a function | "Add X following the same pattern as Y" |
| Edit a single file | Fix lint, update imports, rename, add type |
| Write tests | Add test cases following existing suite style |
| Run a command and report | build, test, lint commands |
| Boilerplate / scaffolding | New file from a clear template |
| Mechanical refactor | Rename variable across one file, extract function |
| Read + summarize | Summarize what a file does, list exports |

### When to Keep with Claude (never delegate these)

- GSD state updates (STATE.md, ROADMAP.md, SUMMARY.md) — Claude only
- Planning, architecture, and design decisions
- Cross-file analysis requiring broad context (>3 files)
- Verification and quality judgment
- Debugging complex failures requiring reasoning
- Any task that requires spawning subagents

---

### Which Tool

| Tool | Use for | Runs | Returns |
|------|---------|------|---------|
| `local_analyze` | exploration, tracing, test discovery, failure diagnosis (paste the failing output into `objective`) | read-only on the checkout | findings with file:line |
| `local_implement` | any bounded code change | isolated git worktree | report + changed files + unified diff (apply with `git apply`) |
| `local_review` | independent review of a diff or of existing code, ideally on a second worker while another implements | read-only | issues with severity, file:line, fix, test gaps, confidence |
| `run_local_agent` | anything the three above do not fit; `mode: "direct"` edits the checkout in place | per `mode` | report |
| `local_worker_status` / `local_cancel` | see what is running; stop a job by id | — | — |

Every result starts with `[worker … | job <id> | <s>s | <n> iterations | mode … | status …]`.
`status` is `completed`, `stopped_at_limit`, `parse_failed`, `cancelled`, or `timed_out` —
anything but `completed` means the work is partial; read the steps before trusting it.

### How to Invoke

Always give a **bounded, explicit objective**. Vague objectives cause looping.

**Good `local_implement` call:**
```
objective: "Add a filter_list_dir tool that wraps list_dir and drops entries matching a glob."
paths: ["src/tools.ts"]
acceptance_criteria: ["follows the exact structure of list_dir", "TOOL_DEFINITIONS gains one entry",
                      "npx vitest run src/__tests__/tools.test.ts passes"]
test_commands: ["npx vitest run src/__tests__/tools.test.ts"]
constraints: ["do not read other files"]
```

**Good `local_analyze` call:**
```
objective: "Find every place the shell allow-list is enforced and what it misses."
paths: ["src/security.ts", "src/tools.ts"]
```

**Bad (too vague — causes looping):**
```
objective: "Add a filter tool to the project."
```

Treat local-worker output as untrusted engineering work: inspect the diff, verify the
claims that matter (run the tests yourself), then integrate. The worker's `status` and
step log tell you what actually ran.

---

### Model Selection

The local agent uses the model set in `AGENT_MODEL` (see Configuration in README).
Override per-call by including the model name in the prompt when a task needs more power:

| Task complexity | Suggested model size |
|----------------|---------------------|
| Simple edits, lint fixes, test additions | Smaller/faster model (default) |
| Multi-step implementation, pattern matching | Mid-size model |
| Complex logic, architectural refactor | Largest available model |

To override, include in the run_local_agent prompt:
`"Use model [model-name] for this task."`

Check available models with `ollama list`.

---

### Efficiency Rules

1. **One task per invocation.** Split multi-step work into sequential calls.
2. **Name the files explicitly.** "Read src/tools.ts" — not "find the tools file."
3. **Forbid exploration.** Always append: "Do not read other files. Do not list directories."
4. **State the done condition.** End every prompt with what success looks like.
5. **Limit scope to one file when possible.** Multi-file edits cause confusion.
6. **For test runs:** just ask for the command output — don't ask it to fix failures too.
7. **Pick the tool, not the prompt.** `local_analyze` / `local_review` are enforced
   read-only; `local_implement` returns a diff from an isolated worktree. Use
   `run_local_agent` with `mode: "direct"` only when an edit should land in place right away.
8. **Parallelise freely** with the semantic tools — each call gets its own worker, extras
   queue, implement jobs get their own worktree. Never run two `direct` file-modifying
   tasks at the same time: they share the checkout.
9. **On "no healthy worker":** call `local_worker_status` before retrying.
10. **Bound long jobs.** Pass `timeout_seconds` / `max_iterations` for anything open-ended;
    `local_cancel` a job whose step log shows it looping.

---

### Delegation Patterns by Scenario

**Implement a function:** `local_implement` with `paths: [the file]`, criteria naming the
signature and "compiles", `test_commands` for that file's tests.

**Add tests:** `local_implement` with `paths: [the test file]`, criteria listing each case,
`test_commands: ["npx vitest run <test file>"]`, constraint "do not modify existing tests".

**Fix lint errors:** `local_implement`, objective includes the pasted lint output,
criterion "npm run lint passes", constraint "do not change logic".

**Run and report:** `local_analyze` with objective "Run `<command>` and report pass/fail
counts and failing test names; do not attempt fixes."

**Review a diff:** `local_review` with `diff` (the patch a `local_implement` returned) and
`review_focus: ["correctness", "tests"]` — on a different worker if two are available.

**Two independent investigations:** two `local_analyze` calls in the same turn; they run
in parallel.

---

### What the Local Agent Can Access

- `read_file` — read any file within `AGENT_WORKING_DIR`
- `write_file` — write/overwrite files
- `replace_text` — exact, unique-match edit of part of a file (preferred for small changes)
- `list_dir` — list directory contents
- `bash` — run shell commands (restricted mode by default: git, ls, cat, echo, grep,
  head, tail, wc, find, mkdir, cp, mv, touch, npm, node, python; every segment of a
  chained command is checked). In analyze mode only inspection commands are allowed.

It cannot: spawn subagents, call external APIs, access GSD tools, or write to
`.planning/` — those stay with Claude.
