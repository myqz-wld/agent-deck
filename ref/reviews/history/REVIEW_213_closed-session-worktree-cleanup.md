---
review_id: 213
reviewed_at: 2026-08-03
baseline_commit: 7b0043bee04efc3a8295c27dae6a41c493f83546
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record and bucket-index maintenance are mechanical archive work."
---

# REVIEW_213_closed-session-worktree-cleanup: Closed-session worktree ownership

## Scope and method

A structured `exit_worktree` restored its owner to the main repository but remained in
`cleanup_pending` because nine completed reviewer rows still persisted the deleted-worktree target
as `sessions.cwd`. The audit traced shutdown lifecycle, persisted cwd classification, adapter
runtime lookup, foreign structured leases, input-drain sealing, Git safety checks, and cleanup
retry settlement. This was an implementation and self-review pass; neither `simple-review` nor
`deep-review` was invoked.

```review-scope
src/main/agent-deck-mcp/tools/handlers/exit-worktree.ts
src/main/session/manager/lifecycle.ts
src/main/session/worktree-transition/__tests__/git-cleanup-references.test.ts
src/main/session/worktree-transition/__tests__/git-cleanup.test.ts
src/main/session/worktree-transition/git-cleanup.ts
src/main/store/worktree-transition-drain-repo.ts
src/main/store/worktree-transition-repo.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | `persistedCwdReferences` treated every session row as permanent cleanup ownership. `shutdown_session` correctly retained reviewer history, so closed reviewers could block worktree removal forever even after their runtimes and leases were gone. | Classify persisted rows by lifecycle. Active and dormant cwd rows remain hard fences; a closed row is releasable only after the independent live-runtime, foreign-lease, and caller-runtime checks pass. |
| LOW | Merely ignoring a closed row would leave future explicit reactivation pointed at a removed directory. | Atomically move each qualifying closed row to the lease's restored `originalCwd`. The conditional update fails closed if the row reactivates or changes cwd during release. |

No confirmed finding remains open.

## Validation and evidence

- Read-only production-state inspection found exactly nine worktree cwd references and every one
  had lifecycle `closed`; the only unsettled transition was the owner's `cleanup_pending` lease.
- The residual worktree was clean, its detached HEAD was reachable from local `main` and
  `origin/main`, and no foreign structured lease targeted the path.
- A validated Electron-ABI operational harness invoked the production cleanup and drain primitives:
  the worktree was removed, the owner transition became `cleared`, and all nine closed reviewer cwd
  rows moved to the main repository. Temporary harness files were removed afterward.
- Focused cleanup coverage passed 2 files and 9 tests. The full Electron-ABI suite passed 466 files
  and 3,851 tests; one credentialed live smoke remained intentionally skipped.
- Node and renderer typechecks and the production main/preload/renderer build passed.
- Logger validation, diff whitespace, review-expiry inventory, and the 500-line production guard
  passed; the changed production cleanup module is 300 lines.

## Fixes landed

- Persisted cleanup ownership now distinguishes active/dormant sessions from closed history.
- Closed rows are rehomed only after runtime and lease ownership are proven absent.
- Conditional SQLite updates preserve fail-closed behavior if a session reactivates during release.
- Regression coverage pins closed release, active/dormant refusal, closed live-runtime refusal,
  closed foreign-lease refusal, and the reactivation race.

## Residual risk

- The installed Agent Deck process remained on its older packaged build so it was not terminated
  during this delivery session. The source fix takes effect on the next normal rebuild/install; the
  concrete residual worktree and transition were already cleaned with the validated current-source
  production primitives.
- No database schema or public MCP contract changed.

## Follow-up

After the next packaged-app restart, smoke one worktree with a closed child reviewer and confirm a
normal `exit_worktree` retry returns `completed-cleanup` without an operational harness.
