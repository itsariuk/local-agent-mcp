# Project Instructions

## Local Agent Delegation

This project has a `run_local_agent` MCP tool connected. Use it to offload mechanical
coding work to the local Ollama model, reserving Claude for reasoning, orchestration,
and judgment.

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

### How to Invoke — Prompt Template

Always give the local agent a **bounded, explicit prompt**. Vague prompts cause looping.

**Template:**
```
Use the run_local_agent tool with this prompt:

"Read [exact file path(s)].
[Single specific action — one task only].
Do not read any other files.
Do not explore the directory.
[Expected output or acceptance criteria]."
```

**Good delegation prompt:**
```
Use run_local_agent: "Read src/tools.ts lines 80-120. Add a new tool called
filter_list_dir that wraps list_dir and removes entries matching a glob pattern.
Follow the exact same structure as list_dir. Do not read other files."
```

**Bad delegation prompt (too vague — causes looping):**
```
Use run_local_agent: "Add a filter tool to the project."
```

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

---

### Delegation Patterns by Scenario

**Implement a function:**
```
Use run_local_agent: "Read [file path]. Implement [function name] that [description].
Follow the existing code style in that file. Do not read other files.
The function is complete when it compiles and matches the signature: [signature]."
```

**Add tests:**
```
Use run_local_agent: "Read [test file path]. Add [N] test cases for [function name]
covering: [case 1], [case 2], [case 3]. Follow the existing test style exactly.
Do not modify test logic outside the new cases."
```

**Fix lint errors:**
```
Use run_local_agent: "Read [file path]. Fix all lint errors reported below.
Do not change any logic — only fix the lint issues.
Errors: [paste lint output]"
```

**Run and report:**
```
Use run_local_agent: "Run [command] from [project root path].
Report: how many tests passed, how many failed, and the names of any failures.
Do not attempt to fix failures."
```

---

### What the Local Agent Can Access

- `read_file` — read any file within `AGENT_WORKING_DIR`
- `write_file` — write/overwrite files
- `replace_text` — exact, unique-match edit of part of a file (preferred for small changes)
- `list_dir` — list directory contents
- `bash` — run shell commands (restricted mode by default: git, ls, cat, echo, grep,
  find, mkdir, cp, mv, touch, npm, node, python)

It cannot: spawn subagents, call external APIs, access GSD tools, or write to
`.planning/` — those stay with Claude.
