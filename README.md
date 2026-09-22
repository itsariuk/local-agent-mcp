# local-agent-mcp

An MCP server that lets a frontier coding agent (Claude Code, Codex, or any MCP client) delegate bounded work to local models running on your own GPUs. Local workers explore the repository, implement changes in isolated git worktrees, run tests, and review diffs; the supervisor keeps the reasoning and gets back a concise report instead of every file read and shell output.

What you get:

- **Semantic tools** — `local_analyze` (read-only investigation), `local_implement` (edits in a throwaway git worktree, returned as a diff), `local_review` (independent review), plus free-form `run_local_agent`
- **A worker pool** — one job per GPU at a time, health checks, queueing, `local_worker_status`
- **Safety** — enforced read-only mode, worktree isolation, a chained-command-aware shell allow-list, timeouts and `local_cancel`
- **Two backends** — Ollama's native API and any OpenAI-compatible server (vLLM, llama.cpp, LM Studio)
- **Records** — every job leaves request, result, transcript and patch on disk; token and timing metrics per worker

## Prerequisites

- **Node.js** 20.3 or later (the server uses `AbortSignal.any`)
- **Ollama** installed and running (`ollama serve`), or an OpenAI-compatible inference server — see [Providers](#providers)
- A pulled tool-calling model: `ollama pull qwen2.5-coder:7b` to start, `qwen3.8:27b` for real work (see [Supported Models](#supported-models))
- **git** on the PATH — `local_implement` isolates each job in a `git worktree`
- **Mac or Linux** (Windows: file tools work, but bash execution is not supported — see [Troubleshooting](#troubleshooting))

## Installation

The server is a stdio MCP server, so it is registered with `claude mcp add`. Pick one:

**A. No clone — run from GitHub via `npx`** (recommended):

```bash
claude mcp add --scope user local-agent \
  --env AGENT_MODEL=qwen3.8:27b \
  --env AGENT_NUM_CTX=32768 \
  -- npx -y github:itsariuk/local-agent-mcp
```

The first start takes a minute (npm fetches and builds the package); later starts are cached. If that first start trips Claude Code's server-startup timeout, run it once as `MCP_TIMEOUT=180000 claude` (milliseconds). Point at a remote Ollama with `--env OLLAMA_HOST=http://<gpu-host>:11434`, or at several workers with `--env AGENT_WORKERS=...` — every variable in [Configuration](#configuration) can be passed this way.

**B. From a clone** (for development, or to pin a build):

```bash
git clone https://github.com/itsariuk/local-agent-mcp.git
cd local-agent-mcp
npm install          # also builds (prepare)
claude mcp add --scope user local-agent -- node "$PWD/build/index.js"
```

Inside the clone itself the included `.mcp.json` registers the server at project scope automatically, so a plain `claude` in that directory already has it.

**Scopes.** `--scope user` makes the server available in every project; omit it for the current project only (stored in `~/.claude.json`), or use `--scope project` to write a shareable `.mcp.json`. Manage it afterwards with `claude mcp list`, `claude mcp get local-agent`, `claude mcp remove local-agent`, and `/mcp` inside Claude Code.

### Codex

Codex registers stdio servers the same way:

```bash
codex mcp add local-agent \
  --env AGENT_MODEL=qwen3.8:27b \
  --env AGENT_NUM_CTX=32768 \
  -- npx -y github:itsariuk/local-agent-mcp
```

Then raise two timeouts in `~/.codex/config.toml` — Codex gives each tool call **60 seconds by default**, and a delegated job routinely runs for minutes:

```toml
[mcp_servers.local-agent]
command = "npx"
args = ["-y", "github:itsariuk/local-agent-mcp"]
startup_timeout_sec = 180   # first start fetches and builds the package
tool_timeout_sec = 1200     # jobs run up to AGENT_JOB_TIMEOUT_SECONDS (900) plus queue time

[mcp_servers.local-agent.env]
AGENT_MODEL = "qwen3.8:27b"
AGENT_NUM_CTX = "32768"
```

Inside a clone, the included `.codex/config.toml` does the same at project scope (Codex applies it to trusted projects only). `codex mcp list` shows what is registered.

**Other MCP clients** get the same server with the equivalent of:

```json
{
  "mcpServers": {
    "local-agent": {
      "command": "npx",
      "args": ["-y", "github:itsariuk/local-agent-mcp"],
      "env": { "AGENT_MODEL": "qwen3.8:27b" }
    }
  }
}
```

Whatever the client, give tool calls at least 20 minutes: a job that hits the client's timeout is killed from outside and returns nothing, whereas `timeout_seconds` on the call itself returns the work done so far.

## Usage

Once registered, the supervisor sees seven tools (full reference in [Tools](#tools)). Ask it in natural language; the included `CLAUDE.md` teaches Claude Code which tool to reach for.

**Investigate — `local_analyze`:**

> Use local_analyze to find every call site of `assertPathSafe` under `src/` and report file:line for each.

Runs read-only against your checkout and returns findings with evidence. Safe to run several in parallel.

**Change — `local_implement`:**

> Use local_implement: objective "add a byte-total line to list_dir output", paths `src/tools.ts` and `src/__tests__/tools.test.ts`, acceptance criteria "existing lines unchanged" and "tools tests pass", test command `npx vitest run src/__tests__/tools.test.ts`.

Runs in a throwaway git worktree seeded with your uncommitted changes, runs the tests there, and returns a report plus a unified diff. Your checkout is never touched — apply the diff with `git apply` when you are happy with it.

**Review — `local_review`:**

> Use local_review on this diff with focus "correctness" and "tests".

Returns issues with severity and file:line, suggested fixes, test gaps, and a confidence level — a cheap way to keep a second GPU busy while the first implements.

**Anything else — `run_local_agent`:**

> Use run_local_agent to run `npm test` and report which tests failed. Do not attempt fixes.

Free-form; `mode` picks read-only, worktree, or in-place editing (default).

**Tips:**
- Give every job a bounded objective, explicit paths, and a done condition; vague objectives make small models loop
- Paths are relative to `AGENT_WORKING_DIR` (defaults to the directory the server was started in)
- Jobs stop after `AGENT_MAX_ITERATIONS` tool-call rounds (default 20) or `AGENT_JOB_TIMEOUT_SECONDS` (default 900); both can be overridden per call
- Every result starts with a header naming the worker, job id, elapsed time, tokens and `status` — read the status before trusting the report

## Configuration

All settings are controlled via environment variables. Set them in your MCP config `env` block or export them in your shell before starting the server.

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Inference endpoint for the single default worker. A URL ending in `/v1` selects the OpenAI-compatible provider (see [Providers](#providers)) |
| `AGENT_WORKERS` | *(unset)* | Several inference endpoints as `id=url,id=url` (e.g., `gpu0=http://host:11434,gpu1=http://host:11435`). Overrides `OLLAMA_HOST`. See [Multiple workers](#multiple-workers) |
| `AGENT_MODEL` | `qwen2.5-coder:7b` | Model to use for agent tasks |
| `AGENT_WORKING_DIR` | Current directory | Root directory for file operations |
| `AGENT_MAX_ITERATIONS` | `20` | Maximum tool-call rounds before stopping |
| `AGENT_TIMEOUT_SECONDS` | `120` | Timeout per bash command in seconds |
| `AGENT_SHELL_MODE` | `restricted` | `restricted` (allow-list), `full` (no restrictions, warning printed), or `none` (bash disabled) |
| `AGENT_ALLOWED_COMMANDS` | *(empty)* | Comma-separated commands to add to the default allow-list (e.g., `rm,curl`) |
| `AGENT_JOB_TIMEOUT_SECONDS` | `900` | Wall-clock limit per job once it has a worker; the job returns what it has when it expires |
| `AGENT_NUM_CTX` | *(Ollama default)* | Context window, sent to Ollama as `options.num_ctx`. Set it for multi-step tasks (e.g., `32768`) — a small context silently drops earlier file reads. Ollama workers only; OpenAI-compatible servers set their context size themselves |
| `AGENT_API_KEY` | *(unset)* | Sent as `Authorization: Bearer …` to OpenAI-compatible servers that require one |
| `AGENT_JOB_LOG_DIR` | `$XDG_STATE_HOME/local-agent-mcp/jobs` (`~/.local/state/…`) | Where per-job records are written (see [Job records and metrics](#job-records-and-metrics)) |

**Default allow-list** (when `AGENT_SHELL_MODE=restricted`): git, ls, cat, echo, grep, head, tail, wc, find, mkdir, cp, mv, touch, npm, npx, node, python.

Use `AGENT_ALLOWED_COMMANDS` to add commands to this list. For example, `AGENT_ALLOWED_COMMANDS=rm,curl` adds `rm` and `curl` while keeping all defaults.

**Example** — custom model with full shell access and longer timeout:

```json
{
  "mcpServers": {
    "local-agent": {
      "command": "node",
      "args": ["build/index.js"],
      "env": {
        "AGENT_MODEL": "qwen2.5-coder:14b",
        "AGENT_SHELL_MODE": "full",
        "AGENT_TIMEOUT_SECONDS": "60"
      }
    }
  }
}
```

**Example** — a 27B-class model on a 24 GB GPU:

```json
{
  "mcpServers": {
    "local-agent": {
      "command": "node",
      "args": ["build/index.js"],
      "env": {
        "AGENT_MODEL": "qwen3.8:27b",
        "AGENT_NUM_CTX": "32768"
      }
    }
  }
}
```

Check the tag with `ollama list`. Lower `AGENT_NUM_CTX` if the model plus context does not fit in VRAM.

Invalid values cause the server to exit immediately with a clear error message — no silent defaults.

## Multiple workers

Set `AGENT_WORKERS` to run jobs on more than one inference endpoint — typically one Ollama instance per GPU:

```json
"env": {
  "AGENT_WORKERS": "gpu0=http://<gpu-host>:11434,gpu1=http://<gpu-host>:11435",
  "AGENT_MODEL": "qwen3.8:27b",
  "AGENT_NUM_CTX": "32768"
}
```

- Each worker runs **one job at a time**. Parallel tool calls go to different workers; extra calls wait in a first-in, first-out queue.
- A worker is probed (`GET /api/version`, or `GET /v1/models` for OpenAI-compatible servers) before every job. A dead one is skipped and the job goes to the next worker. A job is never moved once it has started, because it may already have written files.
- Every report starts with a line saying where it ran: `[worker gpu0 | qwen3.8:27b | job 3f2a1c9e | 17.8s | 3 iterations | 6.1k→0.9k tok | mode analyze | status completed]`. The time includes any wait in the queue.
- Pass `worker: "gpu1"` to any job tool to target one worker, for diagnostics.
- All workers use `AGENT_MODEL` unless a call passes `model`.

### Providers

Each worker talks to one of two backends, chosen from its URL:

| URL | Provider | Endpoints used |
|-----|----------|----------------|
| `http://host:11434` (anything not ending in `/v1`) | Ollama native API | `POST /api/chat`, `GET /api/version` |
| `http://host:8001/v1` (ends in `/v1`) | OpenAI-compatible chat completions | `POST /v1/chat/completions`, `GET /v1/models` |

The OpenAI-compatible provider is for vLLM, llama.cpp `server`, LM Studio, and Ollama's own `/v1` endpoint. Mixing is fine:

```
AGENT_WORKERS=gpu0=http://gpu-host:11434,gpu1=http://gpu-host:8001/v1
```

Verified so far: Ollama's native API and Ollama's `/v1` endpoint (same model, both providers, live). vLLM, llama.cpp and LM Studio follow the same contract but have not been run against this server yet — if one misbehaves, the error text starts with `OpenAI-compatible server error:` and includes the first 200 characters of the server's reply.

`local_worker_status` shows each worker's `provider`.

With a single endpoint (just `OLLAMA_HOST`, or one entry in `AGENT_WORKERS`) you still get the queue and the health check: parallel calls line up instead of competing for the same GPU.

**Parallel jobs:** `analyze` and `implement` mode jobs are always safe to run in parallel (see [Execution modes](#execution-modes)). Only `direct` mode jobs share the checkout — do not run two of those that modify files at the same time.

The `local_worker_status` tool shows the pool:

```json
{
  "workers": [
    { "id": "gpu0", "status": "busy", "model": "qwen3.8:27b", "provider": "ollama",
      "job_id": "3f2a1c9e", "busy_seconds": 12,
      "jobs": 7, "busy_seconds_total": 412, "tokens": { "prompt": 98210, "completion": 6120 } },
    { "id": "gpu1", "status": "idle", "model": "qwen3.8:27b", "provider": "ollama",
      "jobs": 5, "busy_seconds_total": 280, "tokens": { "prompt": 61004, "completion": 4090 } }
  ],
  "queued": 0,
  "metrics": { "jobs": { "started": 12, "completed": 11, "cancelled": 1 }, "tokens": { "prompt": 159214, "completion": 10210 },
               "tool_calls": 63, "chars_consumed": 412880, "chars_returned": 31200,
               "supervisor_context_saved_chars": 381680, "since": "2026-09-21T18:02:11.000Z" }
}
```

`status` is `idle`, `busy`, `probing` (claimed for a job, health check still running), or `unhealthy` (the endpoint did not answer its last probe). The `metrics` block is described under [Job records and metrics](#job-records-and-metrics).

## Tools

| Tool | Inputs | What it does |
|------|--------|--------------|
| `local_analyze` | `objective`, `paths[]`, `constraints[]?` | Read-only investigation of the checkout. Returns findings with file:line evidence. |
| `local_implement` | `objective`, `paths[]`, `acceptance_criteria[]`, `test_commands[]`, `constraints[]?` | Bounded change in an isolated git worktree. Returns report + changed files + unified diff. |
| `local_review` | `objective`, `paths[]?`, `diff?`, `review_focus[]?` | Read-only review: issues with severity and file:line, fixes, test gaps, confidence. |
| `run_local_agent` | `prompt`, `mode?` | Free-form task; `mode` picks the execution mode below (default `direct`). |
| `local_worker_status` | — | Workers, their state, running job ids, queue length. |
| `local_cancel` | `job_id` | Stops a running job; its call returns with `status cancelled` and the work so far. |
| `local_job_log` | `job_id`, `tail?` | Reads a finished job's stored record: request, result summary, and the last N transcript entries with unclipped tool output. |

The job tools also accept `worker`, `model`, `max_iterations`, and `timeout_seconds` overrides.

Every result starts with a header:

```
[worker gpu0 | qwen3.8:27b | job 3f2a1c9e | 41.2s | 7 iterations | mode implement | status completed]
```

`status` is one of `completed`, `stopped_at_limit` (hit `max_iterations`), `parse_failed` (the model never produced a usable tool call), `cancelled`, or `timed_out`. Anything but `completed` means the report is partial — the steps so far and, for `implement`, the partial diff are still returned so nothing is lost, but nothing is claimed either.

### Cancellation and timeouts

- `local_cancel(job_id)` aborts the in-flight model request and kills any running shell command; the worker is freed at once.
- Every job has a wall-clock limit: `AGENT_JOB_TIMEOUT_SECONDS` (default 900), or `timeout_seconds` per call. The clock starts when the job gets a worker, so queue time does not count.
- If the MCP client cancels or disconnects, a running job is aborted and a queued one is dropped.
- Job ids appear in result headers and in `local_worker_status`; a queued job has no id yet.

## Job records and metrics

Every job leaves a directory under `AGENT_JOB_LOG_DIR` (default `~/.local/state/local-agent-mcp/jobs`, never inside your repository):

```
jobs/3f2a1c9e/
  request.json     tool, mode, prompt, worker, provider, model, limits, started_at
  result.json      status, iterations, elapsed_ms, usage, tool_calls, files_read, files_changed,
                   commands_run (with pass/fail), chars_consumed, chars_returned, error?, worktree?
  transcript.jsonl one line per chat message — the full, unclipped tool output lives only here
  patch.diff       implement mode only
```

Writes are best effort: an unwritable directory is logged (`[jobs] failed to write …`) and never fails a job. The worker is released before the record is flushed, so the disk never holds a GPU, but the tool call does not return until the record is on disk. Transcripts are not redacted; they contain whatever files the worker read.

Result headers show token usage when the backend reports it: `| 18.4k→1.2k tok |` is prompt→completion. Any status other than `completed` ends the result with `[full log: local_job_log("<id>")]`.

`local_worker_status` adds per-worker totals (`jobs`, `busy_seconds_total`, `tokens`) and a `metrics` block for the server's lifetime:

| Field | Meaning |
|-------|---------|
| `jobs` | counts by outcome: `started`, `completed`, `stopped_at_limit`, `parse_failed`, `cancelled`, `timed_out`, `failed`, `blocked` |
| `tokens` | prompt / completion tokens across all jobs (local, i.e. free) |
| `tool_calls` | tool invocations across all jobs |
| `chars_consumed` | tool output plus model text the workers processed |
| `chars_returned` | what the supervisor actually received |
| `supervisor_context_saved_chars` | `chars_consumed − chars_returned` — a **lower bound, in characters**, on frontier-model context the local workers absorbed. It is not tokens and not money; divide by ~4 for a rough token estimate |
| `since` | when these counters started (server start) |

**Benchmarking supervisors.** To compare Claude Code and Codex as the supervisor, run the same task list through each with this server attached, then compare the paid-model token usage each client reports against `metrics.tokens` and `supervisor_context_saved_chars` here. The per-job `result.json` files are the raw data if you want a finer breakdown.

## Execution modes

`run_local_agent` takes an optional `mode` (the semantic tools pick theirs: `local_analyze` and `local_review` are `analyze`, `local_implement` is `implement`):

| Mode | Runs in | File tools | Shell | Returns |
|------|---------|------------|-------|---------|
| `analyze` | your checkout | read only (`read_file`, `list_dir`) | read-only list: `ls cat head tail wc grep rg find echo diff sort uniq`, and `git` limited to `status diff log show ls-files grep blame rev-parse describe show-ref`; no `>`/`tee`/`--output` or other write/exec flags; ignores `AGENT_SHELL_MODE=full` | findings |
| `implement` | a throwaway git worktree | all | normal allow-list | report + changed files + unified diff; your checkout is never touched |
| `direct` (default) | your checkout | all | normal allow-list | report; edits land in place |

**How `implement` works.** The worktree is created under the OS temp dir from `HEAD` plus your uncommitted changes (tracked edits and untracked files), committed there as a base. Dependency directories (`node_modules`, `.venv`, `venv`, `vendor`) are symlinked in when they are git-ignored, so tests can run; build output directories are not linked, so a build inside the worktree stays inside it. The worker edits and runs commands inside the worktree. The result ends with:

```
--- changes (2 files) ---
M	src/config.ts
A	src/__tests__/new.test.ts

diff --git a/src/config.ts b/src/config.ts
...
```

The diff is relative to your current tree, so `git apply` (or `git apply --3way`) lands it. The worktree is removed on success; if the job errors it is kept and the error message says where, so you can inspect it (`git worktree remove --force <path>` when done). `implement` needs the working directory to be inside a git repository.

**Chained commands.** In restricted mode every segment of `a && b`, `a | b`, `a; b`, `a & b` is checked against the allow-list, and command/process substitution (`$(...)`, backticks, `<(...)`) is rejected. A `;` or `&&` inside a quoted argument is rejected too — the worker gets a clear error and can rephrase.

## Supported Models

Any Ollama model that supports tool calling works. Recommended options:

| Model | Size | VRAM | Tool-Call Reliability | Recommended Use |
|-------|------|------|----------------------|-----------------|
| `qwen2.5-coder:7b` | 4.7 GB | ~6 GB | Good | Default — runs on most hardware |
| `qwen2.5-coder:14b` | 9.0 GB | ~12 GB | Very good | Better reasoning, mid-range GPU |
| `qwen2.5-coder:32b` | 18 GB | ~24 GB | Excellent | Best quality, requires high-end GPU |
| `qwen3.8:27b` | 17.7 GB | ~24 GB | Excellent (native tool calls) | Multi-step edit/test tasks; set `AGENT_NUM_CTX` |
| `llama3.1:8b` | 4.7 GB | ~6 GB | Moderate | Alternative if qwen unavailable |

To upgrade: set `AGENT_MODEL=qwen2.5-coder:14b` (or `32b`) in your MCP config `env` block. Pull the model first:

```bash
ollama pull qwen2.5-coder:14b
```

## Claude Code Integration (CLAUDE.md)

This repo includes a `CLAUDE.md` file that instructs Claude Code and any subagents (including GSD executors) when and how to delegate tasks to the local workers automatically.

**What it configures:**

- Which task types go to the local workers (exploration, bounded implementation, tests, lint fixes, review, command runs) vs stay with Claude (planning, orchestration, verification)
- Which tool to use for what — `local_analyze` / `local_implement` / `local_review`, with `run_local_agent` as the fallback — and how to write a bounded objective with acceptance criteria and test commands
- Model selection per task complexity via the per-call `model` override
- Efficiency rules: parallelise read-only work, never run two in-place (`direct`) edits at once, bound long jobs with `timeout_seconds`, treat worker output as untrusted until verified

The server itself is client-agnostic: the same tool surface works from Codex or any other MCP client; only the delegation guidance in `CLAUDE.md` is Claude-specific.

**If you use GSD:** executor subagents read `CLAUDE.md` and will follow delegation rules during phase execution automatically.

**If you use Claude Code directly:** Claude reads `CLAUDE.md` at session start and will offer to delegate mechanical coding tasks to the local agent.

You can edit `CLAUDE.md` to add project-specific rules or adjust which tasks get delegated.

## Troubleshooting

**"Connection refused" or "ECONNREFUSED"**

Ollama is not running. Start it with `ollama serve` or check if it's listening on the expected host (`OLLAMA_HOST`).

**"model not found" or 404 from Ollama**

The model hasn't been pulled. Run `ollama pull qwen2.5-coder:7b` (or whichever model you've configured).

**"path not allowed"**

The agent tried to access a file outside its working directory. Set `AGENT_WORKING_DIR` to the correct project root, or check that file paths in the task are relative to the working directory.

**Bash commands fail on Windows**

Bash execution uses Unix process groups (`kill(-pid)`) which are not available on Windows. File tools (`read_file`, `write_file`, `replace_text`, `list_dir`) work on all platforms. Set `AGENT_SHELL_MODE=none` to disable bash entirely.

### "no OpenAI-compatible server at …" / "OpenAI-compatible server error: 4xx"

The worker's URL ends in `/v1`, so the server is expected to speak the OpenAI chat-completions API. Check that it is running, that the model name in `AGENT_MODEL` matches what `GET /v1/models` lists, and set `AGENT_API_KEY` if the server requires a token. A 400 mentioning `tools` usually means the loaded model has no tool-calling support.

### "no healthy worker available"

No configured endpoint answered its health probe. Call `local_worker_status` to see which workers are `unhealthy`, then check that Ollama is running on those hosts and listening on a reachable address (`OLLAMA_HOST=0.0.0.0:11434` on the Ollama side if it is on another machine).

### "blocked: ... is not inside a git repository"

`mode: "implement"` needs `AGENT_WORKING_DIR` (or the directory the server started in) to be inside a git repository, because it isolates the job in a `git worktree`. Use `direct` or `analyze` mode for non-git directories.

## License

MIT
