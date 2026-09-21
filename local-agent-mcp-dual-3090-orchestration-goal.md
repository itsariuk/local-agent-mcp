# local-agent-mcp: Dual-3090 Local Worker Orchestration Goal

**Status:** implementation brief / target specification  
**Date:** 2026-09-21  
**Upstream:** https://github.com/stupakzm/local-agent-mcp

## 1. Goal

Turn `local-agent-mcp` into a reliable local coding-worker layer that can be used by either **Claude Code** or **Codex** as the frontier-model supervisor.

The supervisor remains responsible for:

- understanding the user's actual intent;
- architecture and ambiguous decisions;
- breaking work into bounded tasks;
- choosing what to delegate;
- reviewing local-agent output;
- resolving conflicts between workers;
- final integration;
- final test/verification decisions.

Local Qwen workers handle expensive, repetitive, or parallelizable work using the user's two RTX 3090 GPUs:

- repository exploration;
- targeted code analysis;
- repetitive refactors;
- implementation of well-scoped changes;
- test creation;
- test-failure analysis;
- lint/type-check fixes;
- independent code review;
- bulk mechanical edits.

Primary objective:

> Reduce paid Claude/Codex inference usage substantially without giving up frontier-model supervision.

A successful system should make the frontier model behave more like a staff engineer coordinating fast local engineers rather than spending its own tokens on every grep, file read, routine edit, and test iteration.

---

## 2. Hardware Target

Primary machine:

- **2 × NVIDIA RTX 3090**
- 24 GB VRAM per GPU
- 48 GB aggregate VRAM, but GPUs should normally be used as **two independent workers**, not tensor-parallelized for this model class.

Initial model target:

- **Qwen3.8-27B**
- quantized to fit comfortably on one RTX 3090;
- one model instance per GPU;
- tool calling enabled;
- long enough context for repository tasks;
- local inference only.

Conceptual layout:

```text
                    Claude Code / Codex
                    frontier supervisor
                            |
                            | MCP
                            v
                 local-agent-mcp coordinator
                     /                 \
                    /                   \
            local worker 0          local worker 1
            Qwen3.8-27B             Qwen3.8-27B
            RTX 3090 #0             RTX 3090 #1
```

The two workers must be independently addressable and capable of running concurrently.

---

## 3. Current Upstream Baseline

As of 2026-09-21, upstream `local-agent-mcp` already provides the essential core:

- MCP server for Claude Code;
- `run_local_agent`;
- Ollama backend through `OLLAMA_HOST`;
- configurable model via `AGENT_MODEL`;
- agent loop with a bounded iteration count;
- file read/write/list operations;
- shell command execution;
- working-directory containment;
- restricted/full/disabled shell modes;
- configurable command timeout;
- command allow-list;
- `CLAUDE.md` guidance describing which work should be delegated locally.

Relevant current configuration includes:

```text
OLLAMA_HOST
AGENT_MODEL
AGENT_WORKING_DIR
AGENT_MAX_ITERATIONS
AGENT_TIMEOUT_SECONDS
AGENT_SHELL_MODE
AGENT_ALLOWED_COMMANDS
```

Current default shell allow-list includes:

```text
git
ls
cat
echo
grep
find
mkdir
cp
mv
touch
npm
node
python
```

This is already enough for a single local autonomous coding worker. The work below is primarily about turning it into a **safe, observable, concurrent worker system**.

---

# 4. Design Principles

## 4.1 Frontier model is always the supervisor

The local model is not expected to equal Claude Sonnet/Opus or the strongest Codex model in architectural reasoning.

Local workers should receive **bounded objectives**, perform the expensive mechanical work, and return structured results.

Bad delegation:

```text
"Fix the whole project."
```

Good delegation:

```text
"Inspect app/services/payment and app/models/voucher.
Identify all code paths that validate agency tax status.
Do not modify files.
Return affected files, current behavior, edge cases,
and a proposed change plan."
```

---

## 4.2 Optimize paid-model tokens, not only local tokens/second

The metric that matters is not Qwen output speed by itself.

The desired reduction is:

```text
Before:

Claude/Codex
  -> grep
  -> read 20 files
  -> inspect tests
  -> generate patch
  -> run tests
  -> read failures
  -> fix patch
  -> review

After:

Claude/Codex
  -> define objective
  -> delegate to local worker
       -> grep/read/edit/test/retry locally
  -> receive concise result + diff
  -> review/verify
```

The local worker should consume the large exploratory/token-heavy portion.

---

## 4.3 Local workers must be agents, not chat endpoints

Do not reduce the system to:

```text
ask_qwen(prompt)
```

Each worker needs its own bounded agent loop with tool use:

```text
reason
  -> search
  -> read
  -> edit/patch
  -> execute command
  -> inspect result
  -> retry if appropriate
  -> return structured result
```

---

## 4.4 Two workers should normally mean two independent model instances

Preferred initial topology:

```text
GPU 0 -> endpoint A -> Qwen3.8-27B
GPU 1 -> endpoint B -> Qwen3.8-27B
```

Do not initially use both GPUs for one 27B request unless benchmarking proves a clear advantage.

Parallel independent workers are more useful for:

- implementation + independent review;
- two independent repository investigations;
- splitting a bulk refactor;
- writing tests while another worker implements;
- comparing two candidate solutions.

---

# 5. Required Upgrade: Multi-Endpoint Worker Pool

This is the highest-priority enhancement.

Upstream currently centers on a single `OLLAMA_HOST`.

Add configuration for multiple workers/endpoints.

Example:

```yaml
workers:
  - id: gpu0
    provider: ollama
    base_url: http://127.0.0.1:11434
    model: qwen3.8:27b
    max_concurrency: 1

  - id: gpu1
    provider: ollama
    base_url: http://127.0.0.1:11435
    model: qwen3.8:27b
    max_concurrency: 1
```

Environment-variable compatibility can remain:

```text
AGENT_WORKERS=gpu0=http://127.0.0.1:11434,gpu1=http://127.0.0.1:11435
AGENT_MODEL=qwen3.8:27b
```

But a config file is preferable once the configuration grows.

### Scheduler requirements

The coordinator should:

1. track whether each worker is idle/busy/unhealthy;
2. assign jobs to idle workers;
3. allow two independent jobs to run concurrently;
4. queue excess jobs;
5. support explicit worker selection for diagnostics;
6. detect backend failure;
7. fail cleanly or retry another worker when appropriate;
8. avoid sending two large requests simultaneously to the same GPU unless explicitly configured.

Suggested states:

```text
idle
busy
unhealthy
disabled
```

Expose basic worker status to the supervisor.

---

# 6. Provider Abstraction

Do not hardwire the improved version permanently to Ollama.

Create a small inference-provider interface so the agent loop is independent of transport.

Minimum providers:

1. **Ollama**
2. **OpenAI-compatible HTTP**

The OpenAI-compatible provider makes the system usable with:

- llama.cpp server;
- vLLM;
- LM Studio;
- other local inference servers.

Conceptual interface:

```ts
interface InferenceProvider {
  chat(request: AgentChatRequest): Promise<AgentChatResponse>;
  health(): Promise<HealthStatus>;
  modelInfo?(): Promise<ModelInfo>;
}
```

Configuration example:

```yaml
workers:
  - id: gpu0
    provider: openai-compatible
    base_url: http://127.0.0.1:8001/v1
    model: qwen3.8-27b

  - id: gpu1
    provider: openai-compatible
    base_url: http://127.0.0.1:8002/v1
    model: qwen3.8-27b
```

This lets us benchmark Ollama vs llama.cpp/vLLM without rewriting the MCP layer.

---

# 7. MCP Tool Surface

Preserve `run_local_agent` for backward compatibility, but add semantic delegation tools.

Recommended public MCP tools:

## 7.1 `local_analyze`

Read-only repository investigation.

Inputs should include:

```text
objective
paths[]
constraints[]
max_iterations?
timeout?
worker?
```

Characteristics:

- filesystem read allowed;
- grep/find/git read operations allowed;
- no file modification;
- no mutating shell commands;
- can run read-only diagnostics where safe;
- returns concise structured findings.

Use for:

- architecture discovery;
- identifying affected files;
- dependency tracing;
- test discovery;
- regression-risk analysis.

---

## 7.2 `local_implement`

Perform a bounded implementation task.

Inputs:

```text
objective
paths[]
acceptance_criteria[]
test_commands[]
constraints[]
max_iterations?
timeout?
worker?
isolation?
```

Characteristics:

- operates in an isolated worktree by default;
- can modify files;
- can run tests/lint/type checks;
- can iterate on failures;
- returns a patch/diff and structured report;
- never commits or merges into the user's main branch unless explicitly requested.

---

## 7.3 `local_review`

Independent review of a patch/diff or current worktree.

Inputs:

```text
objective
diff?
paths[]
review_focus[]
worker?
```

Read-only.

Returns:

```text
issues
severity
file/line references where possible
reasoning summary
suggested fixes
test gaps
confidence
```

This should be an especially cheap way to use GPU #2 while GPU #1 implements.

---

## 7.4 Optional `local_test_failure`

Specialized failure analysis.

Inputs:

```text
command
stdout/stderr
affected_paths[]
recent_diff?
```

It can inspect relevant repository files and propose or perform a targeted correction depending on requested mode.

---

## 7.5 Keep `run_local_agent`

Maintain compatibility for free-form tasks:

```text
run_local_agent(task)
```

But supervisor instructions should favor semantic tools when available.

---

# 8. Critical Requirement: Git Worktree Isolation

Two write-capable workers must **never edit the same checkout concurrently**.

Read-only jobs may inspect the main working tree.

Write jobs should default to:

```text
main working tree
       |
       +-- temp worktree job-A
       |
       +-- temp worktree job-B
```

Each job gets:

- its own temporary git worktree;
- its own branch or detached worktree;
- the exact starting commit recorded;
- independent filesystem mutations;
- independent tests;
- a final `git diff`.

After completion:

- return the patch/diff to Claude/Codex;
- supervisor decides whether/how to integrate;
- remove temporary worktree unless retention is requested.

### Dirty working tree handling

Do not silently ignore uncommitted user changes.

Options:

1. default: refuse write delegation if the base state cannot be represented safely;
2. support creating a temporary snapshot/patch that is applied into the worker worktree;
3. eventually support explicit `include_uncommitted=true`.

Initial implementation should favor correctness over magic.

---

# 9. Read-Only vs Write-Capable Execution Profiles

Create explicit execution profiles.

## `analyze`

Allowed:

```text
read_file
list_dir
grep
find
git status
git diff
git log
git show
test discovery
safe read-only commands
```

Forbidden:

```text
write_file
rm
mv
cp that overwrites
git commit
git reset
git checkout affecting user worktree
package installation
network operations by default
```

## `implement`

Allowed within isolated worktree:

```text
read
write
patch/edit
mkdir
tests
lint
type checking
build commands
git diff/status
```

Still forbidden by default:

```text
git push
git reset --hard
git clean -fdx
sudo
system package manager changes
Docker destructive/global operations
credential access
arbitrary network access
```

## `review`

Strictly read-only.

---

# 10. Add a Real Patch/Edit Tool

A coding worker should not have to overwrite an entire file for every change.

Add a deterministic edit mechanism, preferably one or both:

```text
apply_patch
replace_text
```

`apply_patch` should accept a unified diff and validate that it applies cleanly.

Benefits:

- fewer model tokens;
- smaller accidental changes;
- better auditability;
- easier result capture;
- lower risk of Qwen rewriting unrelated content.

---

# 11. Repository Search Tools

Do not make Qwen waste shell/tool cycles on basic repository navigation.

Provide first-class agent tools for:

```text
grep/search
find_files
read_file
read_file_range
list_dir
git_diff
git_status
```

Prefer `rg` when available.

Useful optional tools:

```text
symbol_search
changed_files
test_file_candidates
```

The goal is to reduce verbose command construction and make tool calls easy for a 27B model to use reliably.

---

# 12. Structured Job Contract

Each delegated task should have an internal job object.

Example:

```json
{
  "job_id": "01J...",
  "mode": "implement",
  "objective": "Add validation for agency tax status",
  "scope": [
    "app/models/agency.rb",
    "app/services/payment/"
  ],
  "acceptance_criteria": [
    "existing behavior remains unchanged for agencies without the flag",
    "new validation has tests"
  ],
  "test_commands": [
    "bundle exec rspec spec/services/payment"
  ],
  "constraints": [
    "do not change public API shape"
  ],
  "worker": "auto",
  "max_iterations": 20
}
```

Return a structured result rather than only prose.

Example:

```json
{
  "job_id": "01J...",
  "status": "completed",
  "worker_id": "gpu0",
  "model": "qwen3.8-27b",
  "iterations": 11,
  "elapsed_ms": 84321,
  "summary": "...",
  "files_read": ["..."],
  "files_changed": ["..."],
  "commands_run": ["..."],
  "tests": {
    "status": "passed",
    "commands": ["..."]
  },
  "diff": "...",
  "warnings": [],
  "confidence": "medium"
}
```

Claude/Codex should be able to understand the result without reading the worker's full transcript.

---

# 13. Do Not Flood the Supervisor Context

This is essential to the purpose of the project.

Do not return:

- every tool call;
- giant shell output;
- every file read;
- the local model's entire reasoning transcript.

Return:

1. short summary;
2. important findings;
3. changed files;
4. patch/diff;
5. commands/tests and results;
6. unresolved issues;
7. truncated diagnostic excerpts only when necessary.

Persist verbose logs locally and expose a separate debug/log retrieval tool if needed.

Suggested result sizes:

```text
normal success: compact
failure: enough diagnostics for supervisor to act
full logs: available on demand only
```

---

# 14. Local Job Logging and Observability

Add per-job logs.

Suggested directory:

```text
.local-agent/
  jobs/
    <job-id>/
      request.json
      result.json
      transcript.jsonl
      commands.log
      stdout.log
      stderr.log
      patch.diff
      metadata.json
```

Record:

- worker;
- provider;
- model;
- timestamps;
- token counts if backend exposes them;
- prompt/context size;
- generation tokens;
- iterations;
- tool calls;
- elapsed time;
- test commands;
- exit codes;
- final state.

This is required to answer the real optimization question:

> How much paid Claude/Codex work are local workers replacing?

---

# 15. Metrics

Track at least:

```text
jobs_started
jobs_completed
jobs_failed
jobs_timed_out
jobs_cancelled

worker_busy_seconds
worker_idle_seconds

prompt_tokens_local
completion_tokens_local

tool_calls
iterations_per_job

files_read
files_changed

test_pass_rate

elapsed_time

estimated supervisor context saved
```

Optional but useful:

```text
local tokens/sec
prompt ingestion tokens/sec
time to first token
VRAM usage
GPU utilization
```

Provide a simple `local_worker_status` MCP tool returning something like:

```json
{
  "workers": [
    {
      "id": "gpu0",
      "status": "busy",
      "model": "qwen3.8-27b",
      "job_id": "01J..."
    },
    {
      "id": "gpu1",
      "status": "idle",
      "model": "qwen3.8-27b"
    }
  ]
}
```

---

# 16. Cancellation and Timeouts

Long agent jobs must be cancellable.

Implement:

```text
local_cancel(job_id)
```

Timeout hierarchy:

1. individual shell-command timeout;
2. inference request timeout;
3. total job wall-clock timeout;
4. maximum agent iterations.

Cancellation must terminate:

- pending inference request where possible;
- shell subprocess/process group;
- job state cleanly;
- temporary resources/worktree.

---

# 17. Async/Parallel Semantics

MCP calls may be initiated concurrently by the supervisor.

The server should be internally concurrency-safe even if the client creates simultaneous tool calls.

A future optional interface could support explicit batch delegation:

```text
local_parallel([
  jobA,
  jobB
])
```

But this is not necessary for v1 if Claude Code/Codex can call two MCP tools concurrently.

Important:

- do not serialize all jobs globally;
- serialize only per worker/GPU;
- independent workers should execute simultaneously.

---

# 18. Model/Worker Routing

Initial scheduler:

```text
first healthy idle compatible worker
```

Later support routing policies:

```text
round_robin
least_busy
explicit
capability
model
```

Possible future topology:

```text
gpu0 -> Qwen3.8-27B
gpu1 -> Qwen3.8-27B

or

gpu0 -> fast Qwen coding worker
gpu1 -> stronger/slower review model
```

Do not bake identical-model assumptions into the scheduler.

---

# 19. Prompting Protocol for Qwen

Local models need much tighter instructions than the frontier supervisor.

System prompt should emphasize:

- perform only the delegated objective;
- do not broaden scope;
- inspect before editing;
- use tools rather than inventing file contents;
- never claim a command passed unless it was run;
- never claim a file was changed unless the tool succeeded;
- prefer minimal diffs;
- preserve existing style;
- run requested validation;
- stop when acceptance criteria are satisfied;
- report uncertainty;
- do not repeatedly retry the same failed operation;
- do not modify unrelated files;
- do not commit/push;
- do not access paths outside the workspace.

For analysis mode:

```text
You are a read-only repository analyst.
Do not modify files.
Return evidence from the repository and concise conclusions.
```

For implementation mode:

```text
You are implementing one bounded task in an isolated worktree.
Make the smallest correct change.
Run the specified validations.
Return a concise report and leave the diff for the supervisor.
```

---

# 20. Supervisor Guidance: CLAUDE.md

Update the supplied `CLAUDE.md` so Claude Code knows exactly when to delegate.

Suggested policy:

```text
Use local workers for substantial repository exploration,
well-scoped implementation, repetitive refactoring, test generation,
test-failure diagnosis, lint/type fixes, and independent review.

Prefer parallel local workers when tasks are independent.

Keep architectural decisions, ambiguous requirements, cross-cutting
tradeoffs, final integration, and final verification with the primary
Claude agent.

For implementation, give local workers explicit scope, acceptance
criteria, and validation commands.

Do not delegate trivial work when calling the local worker would cost
more context/time than doing it directly.

Use a second worker for independent review when the change is
non-trivial.

Treat local-worker output as untrusted engineering work:
inspect important diffs and verify critical claims before finalizing.
```

---

# 21. Codex Compatibility

Do not make the server Claude-specific.

The MCP implementation and tool descriptions should work with any compliant MCP client.

Keep supervisor-specific advice separate:

```text
CLAUDE.md
docs/codex.md
```

The same worker pool should be reusable as:

```text
Claude Code
    |
    +---- MCP ----+
                 local-agent-mcp
    +---- MCP ----+
    |
Codex
```

This allows direct A/B testing of Claude vs Codex as the supervisor without changing local infrastructure.

---

# 22. Security / Blast-Radius Controls

Local does not mean safe.

The local model is still an autonomous process with tool access.

Required controls:

- workspace root enforcement;
- normalized/canonical path checks;
- reject `..` traversal and symlink escape;
- shell allow-list in restricted mode;
- no `sudo`;
- no destructive git commands by default;
- no network access by default for local worker shell;
- redact likely secrets from returned logs;
- maximum output sizes;
- maximum file-read sizes;
- command timeout;
- total-job timeout;
- iteration limit;
- worktree isolation for writes;
- explicit opt-in for full shell mode.

Strongly consider process/container sandboxing later.

---

# 23. Shell Safety Improvements

The existing restricted allow-list is a useful start but command-name allow-lists alone are insufficient.

Examples:

```text
git clean -fdx
git reset --hard
python -c '... arbitrary filesystem code ...'
node -e '... arbitrary filesystem code ...'
```

all bypass the spirit of a simple binary allow-list.

For production-quality safety:

- distinguish read-only and write profiles;
- inspect dangerous argument patterns;
- run write agents only inside disposable worktrees;
- optionally wrap execution in a container/sandbox;
- make full shell an explicit configuration.

Isolation is more important than trying to enumerate every dangerous command.

---

# 24. Configuration Proposal

Prefer a file such as:

```text
~/.config/local-agent-mcp/config.yaml
```

Example:

```yaml
server:
  max_parallel_jobs: 2
  job_log_dir: ~/.local/state/local-agent-mcp/jobs

defaults:
  model: qwen3.8-27b
  max_iterations: 20
  job_timeout_seconds: 900
  command_timeout_seconds: 120
  shell_mode: restricted
  worktree_isolation: true

workers:
  - id: gpu0
    provider: openai-compatible
    base_url: http://127.0.0.1:8001/v1
    model: qwen3.8-27b
    concurrency: 1

  - id: gpu1
    provider: openai-compatible
    base_url: http://127.0.0.1:8002/v1
    model: qwen3.8-27b
    concurrency: 1

security:
  allow_network: false
  allow_git_push: false
  allow_sudo: false
  retain_worktrees_on_failure: true
```

Environment variables should override config values for deployment/debugging.

---

# 25. Failure Behavior

The worker must distinguish:

```text
completed
completed_with_warnings
failed
timed_out
cancelled
blocked
```

Examples of `blocked`:

- dirty base tree cannot safely be cloned into a worktree;
- path outside allowed root;
- command not permitted;
- required model unavailable;
- worker endpoint unhealthy.

Do not fabricate partial success.

If max iterations are exhausted, return:

- work completed so far;
- current diff if any;
- last relevant failure;
- what remains unresolved.

---

# 26. Testing Strategy

## Unit tests

Add tests for:

- worker config parsing;
- worker selection;
- busy/idle state transitions;
- endpoint health failures;
- queueing;
- provider abstraction;
- path containment;
- symlink escape;
- shell profile enforcement;
- patch application;
- result truncation;
- timeout handling;
- cancellation;
- worktree creation/cleanup;
- dirty-tree handling.

## Integration tests

Run with mocked inference servers to verify:

```text
MCP initialize
tools/list
single analyze job
single implement job
two parallel jobs -> different workers
third job queues
worker failure -> safe error/fallback
cancel active job
timeout
worktree isolation
diff return
```

## Real-GPU acceptance test

With two live Qwen instances:

1. start worker on GPU0;
2. start worker on GPU1;
3. submit two independent repository analyses simultaneously;
4. verify both GPUs are active;
5. submit independent implementation jobs;
6. verify separate worktrees;
7. verify main checkout is unchanged;
8. review returned diffs;
9. measure throughput and local token usage.

---

# 27. Acceptance Criteria for v1

The fork is ready for daily use when all of these are true:

- [ ] Claude Code can connect through MCP.
- [ ] Codex can connect through the same MCP server.
- [ ] Two Qwen3.8-27B instances can be configured.
- [ ] Each worker is pinned/routed to a separate inference endpoint/GPU.
- [ ] Two independent jobs execute concurrently.
- [ ] A third job queues rather than overloading a worker.
- [ ] Analysis jobs are enforced read-only.
- [ ] Implementation jobs run in isolated git worktrees.
- [ ] Two write jobs cannot corrupt each other's checkout.
- [ ] Main user's working tree is never silently modified by a delegated implementation.
- [ ] Local worker can search/read/edit/patch/run tests.
- [ ] Local worker can iterate after test failures.
- [ ] Final result contains concise summary + changed files + tests + diff.
- [ ] Full worker transcript is not dumped into supervisor context by default.
- [ ] Jobs have IDs and persisted logs.
- [ ] Jobs can time out safely.
- [ ] Jobs can be cancelled.
- [ ] Backend health is visible.
- [ ] Worker status is queryable.
- [ ] Failed jobs do not pretend to succeed.
- [ ] Supervisor instructions encourage delegation but retain final verification.
- [ ] Local inference provider is not permanently tied to Ollama.
- [ ] Existing single-worker `run_local_agent` usage remains compatible.

---

# 28. Suggested Implementation Order

## Phase 1 — Make upstream usable with Qwen3.8

- add/test Qwen3.8 model configuration;
- verify tool-call format;
- tune system prompt;
- increase sensible iteration/command timeouts;
- add deterministic patch/edit tool;
- improve concise result formatting.

## Phase 2 — Two-GPU worker pool

- worker abstraction;
- multiple endpoints;
- health checks;
- scheduler;
- concurrent jobs;
- worker status.

This is the first major milestone.

## Phase 3 — Safe write orchestration

- read-only vs write execution modes;
- git worktree manager;
- dirty-tree behavior;
- final diff capture;
- cleanup.

This is required before routinely allowing two workers to implement code.

## Phase 4 — Better MCP API

Add:

```text
local_analyze
local_implement
local_review
local_test_failure
local_worker_status
local_cancel
```

Keep `run_local_agent`.

## Phase 5 — Provider abstraction

- preserve Ollama;
- add OpenAI-compatible provider;
- validate llama.cpp/vLLM path.

## Phase 6 — Observability and optimization

- job records;
- token/timing metrics;
- worker utilization;
- context/result truncation;
- benchmark Claude vs Codex supervision.

---

# 29. Initial Daily Workflow

A good default workflow should look like this:

```text
User
 |
 v
Claude Code / Codex
 |
 | Understand request
 | Make architectural decisions
 |
 +---- local_analyze(worker=auto)
 |       |
 |       +---- GPU0/Qwen explores repository
 |
 +---- local_analyze(worker=auto)
         |
         +---- GPU1/Qwen independently checks tests/edge cases

       [parallel]

Supervisor reconciles findings
 |
 +---- local_implement(...)
 |       |
 |       +---- GPU0/Qwen works in isolated worktree
 |
 +---- local_review(...)
         |
         +---- GPU1/Qwen reviews relevant existing code or candidate diff

Supervisor:
  inspect diff
  resolve concerns
  run/verify critical tests
  integrate final change
```

For bulk refactors:

```text
Supervisor establishes one canonical transformation first.

GPU0 -> batch A in worktree A
GPU1 -> batch B in worktree B

Supervisor reviews/integrates both.
```

Do not let two local models independently invent different conventions for a bulk refactor before the supervisor establishes the intended pattern.

---

# 30. Benchmark Plan

The point of the project is economic/productivity improvement, so measure it.

Use a representative suite of real coding tasks:

1. repository investigation;
2. small bug fix;
3. medium feature;
4. repetitive refactor;
5. test generation;
6. failing-test diagnosis;
7. code review.

Run each in:

```text
A. Claude Code / Codex alone
B. Frontier supervisor + one local Qwen
C. Frontier supervisor + two local Qwen workers
```

Measure:

- wall-clock completion time;
- paid-model token usage / quota impact;
- local model tokens;
- number of supervisor corrections;
- test success;
- diff quality;
- regressions;
- amount of local work discarded;
- human intervention required.

The system is successful if B/C materially reduce paid inference while preserving acceptable engineering quality.

---

# 31. What Not to Build Yet

Avoid premature complexity.

Do **not** initially build:

- elaborate web UI;
- distributed cluster scheduler;
- shared long-term vector memory;
- autonomous planning hierarchy;
- five different local models;
- automatic merging of worker branches;
- automatic `git push`;
- unattended production changes;
- complicated inter-agent chat protocols.

The v1 product is:

> A frontier coding agent can reliably delegate bounded work to two fast local autonomous Qwen workers, in parallel, without risking the user's checkout or flooding frontier-model context.

---

# 32. End-State Definition

The project is done when this feels natural:

```text
User:
"Implement this change and make sure we didn't miss related paths."

Claude Code / Codex:
- understands the request;
- delegates repository investigation to local worker #1;
- delegates independent test/risk analysis to local worker #2;
- reconciles results;
- delegates a bounded implementation;
- gets back a tested patch rather than a wall of model chatter;
- independently reviews the important pieces;
- presents the final result.

The local GPUs do most of the token-heavy mechanical work.
The frontier model spends its quota on judgment.
```

That is the goal.
