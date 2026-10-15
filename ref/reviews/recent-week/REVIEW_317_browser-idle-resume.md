---
review_id: 317
reviewed_at: 2026-10-11
baseline_commit: 11cfd0cf4d8259d0a7f4e71b5955ff5c10c72171
expired: false
---

# Browser runtime recovery after idle session closure

## Scope and method

Investigated the reported repeated `Browser runtime context is unavailable.` failures after an
idle day, including session decay, SDK ownership, Browser capability renewal, Codex process
replacement, and Gateway recovery. This is a source investigation and regression validation,
not a paired reviewer run or an installed overnight observation.

```review-scope
src/main/browser-use/browser-runtime-context.ts
src/main/browser-use/browser-runtime-context.test.ts
src/main/browser-use/browser-runtime-context-host.ts
src/main/browser-use/browser-runtime-context-host.test.ts
src/main/browser-use/browser-runtime-lifecycle.ts
src/main/browser-use/session-browser.ts
src/main/browser-use/browser-idle-resume.test.ts
src/main/session/lifecycle-scheduler.ts
```

The review-expiry script was attempted and exited with status 1 during its historical mapping.
Git history and previous parseable scopes were inspected directly; no previous coverage was used
to exempt the changed files. Scheduler and Browser disposal coverage had expired through churn.

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Default 24-hour dormant closure deleted the Browser runtime registration while retaining the SDK session and its frozen environment. Next-turn renewal silently found no record, leaving a stale runtime key and launcher path. | SDK-owned automatic closure now suspends the lease and closes tabs while retaining the host-owned layout. The next trusted provider-turn boundary restores the same path and issues fresh authority. Unowned sessions still dispose the context. |
| MEDIUM | Codex process startup refreshed that stale environment key without an error boundary, rejecting the entire model turn with the screenshot's exact error. | Process renewal is best-effort. Missing, suspended, or unrecoverable Browser contexts leave Browser unavailable without rejecting ordinary provider startup. |

Gateway switching is not necessary to reproduce the failure. A process exit or recycle exposes
the stale key; failed-turn Gateway recovery can be one route to a new process generation.
The screenshot does not establish the affected installation's exact Gateway sequence.
An application restart discards the retained client and creates a fresh Browser registration,
which explains why restarting clears the reported condition.

## Lifecycle boundaries

- Idle suspension immediately revokes the old lease even before its natural expiry.
- Refreshing a process by its environment key cannot resume a suspended owner.
- Only session-scoped provider-turn renewal resumes retained state, with a new lease/generation.
- Application-id and native-id SDK claims both preserve the correct owner's layout.
- Rename transfers suspended ownership; old names cannot revive it.
- Explicit close, delete, handoff, replacement, and shutdown keep permanent revocation semantics.
- Missing temporary directories are recreated at the existing provider path. Unsafe paths remain
  rejected; failed remounts do not grant Browser authority or block chat.
- Claude, Codex, and Grok share the repaired local runtime lifecycle. Gateway protocol, session
  identity/history, model choices, and provider permissions are unchanged.

## Validation and evidence

- Before the repair, the new integration file failed 3 of 4 cases, including the exact
  `Browser runtime context is unavailable.` exception from the real Codex process-start host.
- Eleven new regression cases cover idle resume, both SDK claim identities, all three adapters'
  suspension/rename behavior, revoked process contexts, storage failure, and permanent cleanup.
- Focused Browser, scheduler, and Codex process-host validation: 35 tests passed.
- Native Codex Gateway acceptance: all 3 cases passed using test-owned homes, HTTP fixtures,
  and processes. HTTP 401, HTTP 503, and truncated streams all recovered to new destinations
  while retaining thread identity and history. The available native Codex was `0.162.1`.
- `pnpm typecheck` passed. An initial unrelated ACP/Grok exhaustiveness error was repaired by
  concurrent dependency-upgrade work before the successful rerun; this repair did not edit it.
- `pnpm test`: 7,083 passed, 3 timed out, and 6 opt-in tests skipped. Rerunning the three affected
  files with two workers passed all 9 tests. They were the checkpoint background worker,
  isolated Grok oneshot runner, and Server Core Grok container transport tests.
- `git diff --check` passed. The Electron SQLite binding hash remained unchanged.

## Residual risk and handoff

Deterministic clock advancement substitutes for a literal overnight installed-app observation.
The full run was not wholly green in one invocation; its three timeout cases passed under bounded
concurrency. All changed source files are below 500 lines and need no split exception.

The fix is in source only. No running Agent Deck instance, installed application, user credentials,
or external Gateway was changed. Loading the repaired main-process code requires an approved app
update/restart. Concurrent README, dependency, and Grok compatibility edits were preserved.

Related plan: [Browser idle recovery](../../plans/recent-week/PLAN_83_browser-idle-resume.md).
