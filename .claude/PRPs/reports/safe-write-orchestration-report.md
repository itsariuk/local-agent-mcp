# Implementation Report: Safe Write Orchestration (Goal Doc Phase 3)

## Summary
`run_local_agent` now takes `mode`: `analyze` (read-only against the checkout: write tools hidden and refused, read-only shell profile, read-only git subcommands, no redirection — overrides `AGENT_SHELL_MODE=full`), `implement` (throwaway `git worktree` seeded with the user's uncommitted changes as a base commit; returns report + changed files + unified diff; checkout never touched; worktree removed on success, kept and reported on failure), and `direct` (default, unchanged). The restricted-mode allow-list now checks every segment of a chained command and rejects command substitution — previously `ls; rm -rf x` passed.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium-Large | Medium-Large |
| Confidence | 8/10 | Single pass; two small hardening changes from the live runs |
| Files Changed | 11 (2 new) | 13 (2 new) — plus `config.test.ts` (comment) and the e2e test |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 0 | Branch + baseline | Complete | 148 tests |
| 1-2 | Shell profiles | Complete | `head`, `tail`, `wc` added to defaults (the model pipes to `head` constantly; all read-only) |
| 3-4 | Read-only tools | Complete | `toolDefinitions(readOnly)`, `executeTool(..., readOnly)` |
| 5 | Loop `readOnly` + analyst prompt | Complete | |
| 6-7 | `worktree.ts` + tests | Complete | `spawn`-based `runGit`, no shell |
| 8 | `mode` in the handler, `formatDiff`, header | Complete | |
| 9 | E2E implement/analyze/direct | Complete | Mock Ollama scripts a `write_file` call when the prompt starts with `write:` |
| 10 | Docs | Complete | README "Execution modes" + troubleshooting; CLAUDE.md rules 7-8 rewritten, template gains `mode` |
| 11 | Validation + live | Complete | Below |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | |
| Unit Tests | Pass | 206 (148 baseline + 58 new) |
| Build | Pass | |
| Integration | Pass | e2e: implement returns `A\tworker.txt` diff, checkout status unchanged, no leftover worktree; analyze refuses `write_file`; direct writes in place |
| Edge Cases | Pass | chained/substituted commands ×9, read-only git ×6, redirection/tee/find-delete, non-repo → blocked, subdirectory working dir, empty diff, 300 KB diff clip, untracked symlink |

## Live Validation (2026-09-21, `qwen3.8:27b`, scratch clone with a deliberate uncommitted edit)

| Check | Result |
|---|---|
| `analyze`: find call sites, then try to append to a file | 4 iterations, 20 s. `grep` worked; `echo … >> src/security.ts` → `command not allowed in analyze mode (no output redirection)`; checkout unchanged |
| `implement`: change a default in `src/config.ts`, fix the test, run vitest | 5 iterations, 18.7 s. Both `replace_text` edits landed in the worktree; vitest ran there via the `node_modules` symlink (27/27); result carried `M` lines for both files and a two-hunk diff; `git apply` of that diff onto the dirty scratch checkout succeeded; `/tmp/local-agent-mcp` empty afterwards; checkout otherwise untouched |

### Found during live runs
1. **`npx` not on the allow-list.** The model routed around it with `node node_modules/vitest/vitest.mjs`. Added `npx` to the defaults — `npm` (incl. `npm exec`) was already allowed, and the README shows `npx vitest`. Defaults are now 17 commands.
2. **Directory-only ignore patterns vs symlinks.** This repo ignores `node_modules/`; that pattern does not match a *symlink* named `node_modules`, so an untracked symlink would have been followed by `copyFile` (EISDIR on a directory target). The snapshot copy now recreates untracked symlinks instead of following them. One test added.

## Files Changed

| File | Action | Lines |
|---|---|---|
| `src/worktree.ts` | CREATED | +131 |
| `src/__tests__/worktree.test.ts` | CREATED | +132 |
| `src/security.ts` | UPDATED | +71 / -14 |
| `src/__tests__/security.test.ts` | UPDATED | +124 / -45 |
| `src/__tests__/tools.test.ts` | UPDATED | +100 / -1 |
| `src/__tests__/server.e2e.test.ts` | UPDATED | +68 / -7 |
| `src/__tests__/loop.test.ts` | UPDATED | +47 / -4 |
| `src/index.ts` | UPDATED | +41 / -15 |
| `src/loop.ts` | UPDATED | +33 / -5 |
| `src/tools.ts` | UPDATED | +20 / -3 |
| `README.md` | UPDATED | +31 / -2 |
| `CLAUDE.md` | UPDATED | +9 / -4 |
| `src/__tests__/config.test.ts` | UPDATED | comment only |

## Deviations from Plan
1. `head`, `tail`, `wc`, `npx` added to `DEFAULT_ALLOWED_COMMANDS` (above). All read-only except `npx`, which is equivalent to the already-allowed `npm exec`.
2. `WRITE_PATTERNS` in `assertReadOnlyShell` also covers `find -execdir/-okdir`, not just `-exec/-ok/-delete`.
3. Untracked symlinks recreated rather than copied (above).

## Issues Encountered
- One full-suite run had 5 e2e failures immediately after editing `security.ts`; three subsequent full runs and isolated runs were all green. Not reproduced. If it recurs, the e2e suite (which spawns the server from source via `tsx`) is the suspect — a stale `tsx` transform during a parallel test run would explain it.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| `security.test.ts` | +38 | chained commands, substitution, read-only list, read-only git, redirection, find write actions |
| `tools.test.ts` | +5 | `toolDefinitions`, write refusal, read still works, bash profile under `full` |
| `worktree.test.ts` | 8 | snapshot, clean repo, non-repo, subdirectory, symlink, diff + apply, empty diff, remove |
| `loop.test.ts` | +5 | read-only tools/prompt/refusal, header with mode, `formatDiff` ×3 |
| `server.e2e.test.ts` | +3 | implement, analyze, direct |

## Code Review Follow-up (2026-09-21, `/code-review` medium, 8 findings, all addressed)

| # | Finding | Fix |
|---|---|---|
| 1 | `ls & curl … \| sh` — lone `&` was not a separator | `&` splits too (except in `>&`/`<&` descriptor redirects) |
| 2 | Process substitution `<(…)`/`>(…)` bypassed the allow-list | Rejected with `$(` and backticks |
| 3 | `git branch -D`, `git tag v1`, `--output=` writable in analyze mode | `branch`/`tag` dropped from the read-only git set (`show-ref` added); `--output` rejected |
| 4 | `sort -o`, `sort --compress-program`, `rg --pre`, `find -fprint*/-fls` write or execute | Added to `WRITE_PATTERNS` (now a list) |
| 5 | Symlinked `AGENT_WORKING_DIR` → `relativeDir` climbed out of the worktree into the real checkout | `fs.realpath(workingDir)` before `path.relative` |
| 6 | Every ignored dir was symlinked, so `npm run build` in the worktree wrote into the user's `build/` | Allow-list `node_modules`, `.venv`, `venv`, `vendor` only |
| 7 | A failure after `worktree add` leaked the worktree | Snapshot wrapped; `removeWorktree` on failure; `captureDiff` failure now also keeps + reports the worktree |
| 8 | `2>&1` rejected as redirection | `2>&1` and `>/dev/null` allowed |

19 tests added (225 total). Residual: the profile is still a deny-list of flags for otherwise read-only commands; a new flag on `rg`/`sort`/`find` that writes would need adding. Real isolation (a container) remains the §22 "later" item.

## Not Verified
- Two `implement` jobs truly in parallel on two GPUs (one live endpoint; they queue). Each still gets its own worktree by construction (unique pool `jobId`).
- Behaviour when a job in a worktree runs `npm install` (writes through the symlink into the real `node_modules`) — documented risk, not exercised.
- Worktree cleanup after a server crash mid-job (`git worktree prune` would be the fix).

## Next Steps
- [ ] `/code-review`, then `/prp-commit`
- [ ] Phase 4: `local_analyze` / `local_implement` / `local_review` / `local_cancel` on top of these modes; make worktrees the default for implementation there
