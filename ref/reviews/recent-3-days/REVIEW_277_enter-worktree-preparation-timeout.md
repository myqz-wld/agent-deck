---
review_id: 277
reviewed_at: 2026-09-23
baseline_commit: 4732351ded7bba2d392ec7145c9e1101cb697ab6
expired: false
---

# Bound enter_worktree filesystem preparation

## Scope and method

Investigated issue `01347dde-5ccb-4676-b369-e0666f3ef6a5` using source tracing,
fault injection, and the existing real-Git transition tests. This is a targeted
debugging record; no independent paired review was requested or performed.

```review-scope
src/main/agent-deck-mcp/tools/handlers/enter-worktree.ts
src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts
src/main/agent-deck-mcp/tools/handlers/_shared/default-impl-deps.ts
src/main/agent-deck-mcp/__tests__/enter-worktree-preparation-failure.test.ts
```

## Evidence and attribution limits

The issue reports tool-use-start event 236021 with no completion after more than
ten minutes, no observed Git child, no destination worktree, and unchanged cwd.
Those are supplied historical observations, not a trace replayed in this task.
The source session is closed, and the normalized-event API rejects this resolution
session's trajectory read as unrelated. No raw transcript or alternate database
access was used to bypass that boundary.

Current preparation first completes bounded Git checks, then awaits asynchronous
path inspection and parent-directory creation. An indefinitely pending filesystem
operation therefore leaves no running Git child and never reaches `git worktree
add`. This reproduces the reported observable state, but does not prove where the
historical request stopped: a provider tool-start event alone is not backend
handler-entry evidence. The older exit-worktree filesystem mitigation does not
cover this enter path.

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Enter preparation and rollback awaited filesystem operations without deadlines, allowing a pending request despite bounded Git commands. | Bound each path check and parent creation to 30 seconds and identify the operation in the timeout error. Bound rollback path inspection and report incomplete cleanup if it cannot finish. |
| MEDIUM | A thrown preparation error escaped without releasing the reserved provider invocation, temporarily obstructing later lifecycle work. | Release the invocation and return an MCP error explaining that no worktree was created and cwd is unchanged. |

Timeouts apply to individual filesystem awaits. Timing out the whole preparation
promise would allow its abandoned continuation to reach Git creation later. The
implemented boundary prevents that continuation; late rollback checks likewise
cannot trigger deletion. Cleanup uncertainty retains the existing lease. Git
timeouts, detached creation, ref preservation, and automatic cwd cutover are unchanged.

## Validation and evidence

- All four new regressions failed against the original implementation: stalled
  path check, stalled parent creation, rejected parent creation, and stalled
  rollback path inspection. They pass after the fix.
- Fake-time tests verify the 30-second errors, invocation release, timer cleanup,
  and absence of creation/deletion after a late filesystem result.
- Focused worktree suite: 14 files and 64 tests passed, including real detached
  creation, unchanged Git refs, repository identity, cleanup, and transition recovery.
- `pnpm typecheck` passed architecture checks and both TypeScript configurations.
- Full `pnpm test`: 1,034 files and 6,414 tests passed; 2 opt-in live tests and
  1 Linux-only test skipped on macOS.
  The Electron test runner was used without rebuilding the SQLite native binding.
- Ran the review-expiry script and inspected the changed code without prior exemptions.
- `git diff --check` passed. Changed source and test files are below 500 lines.

## Residual risk

- Timers depend on a responsive event loop. This does not diagnose provider dispatch
  stalls, blocked main-thread operations, or the historical filesystem-pool occupant.
- Native asynchronous mkdir cannot be cancelled; a late completion can leave an empty
  parent directory, as already allowed by the tool contract. It cannot resume Git creation.
- Terminating a provider orchestration wait is not evidence of backend cancellation.
  This change adds bounded filesystem failure handling, not transport cancellation.
- Source changes require a rebuilt/restarted main runtime to take effect. No live
  Agent Deck process, installed bundle, original checkout, or historical worktree
  was restarted, replaced, or mutated during validation.

## Follow-ups

The confirmed defect is worth fixing because it blocks isolation and the repair
is limited to two source files. The issue was closed at the user's request after
source validation. Historical causality remains unproven, and acceptance in an
updated runtime remains a separate follow-up. If the symptom recurs, determine
whether the request reached the backend before making further lifecycle changes.

Related plan: [PLAN_56](../../plans/recent-3-days/PLAN_56_enter-worktree-preparation-timeout.md).
