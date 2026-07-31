---
review_id: 202
reviewed_at: 2026-07-30
baseline_commit: cd900897e9522bce2237073959ea35d11da277a8
expired: false
---

# REVIEW_202_worktree-resume-recovery-race: Revival-only worktree recovery

## Scope and method

Diagnosed a real Codex `enter_worktree` trace where resume recovery ran before the live cwd
coordinator switched from the original repository to the prepared worktree. Reviewed startup
reconciliation, session lifecycle broadcasts, generation ownership, the coordinator phases, and
the resume listener's unit coverage.

```review-scope
src/main/session/worktree-transition/resume-recovery.ts
src/main/session/worktree-transition/__tests__/resume-recovery.test.ts
```

## Finding

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The resume listener treated every active `session-upserted` broadcast as proof of a revival. Context-usage and activity updates can emit that broadcast during `enter_waiting_tool_result`, `interrupting_enter_turn`, or `switching_to_worktree`, so crash recovery could race the live coordinator. Depending on phase, it could emit a false runtime-cwd conflict or roll back a worktree whose provider result was still in flight. | Track only generation-qualified transitions observed while their session is missing, closed, or archived. Consume that proof on revival, recheck lifecycle/generation/phase in the microtask, and ignore ordinary active-session broadcasts. |

## Fixes landed

- Seed deferred generations from pending startup rows whose sessions remain unavailable.
- Record transitions that become closed or archived after startup.
- Require the exact deferred generation before scheduling recovery.
- Recheck session availability and transition phase immediately before recovery.
- Restore deferred eligibility after a fail-closed recovery error so a later real retry remains
  possible.
- Clear deferred state for settled or stopped listeners.
- Cover closed and archived startup recovery, post-start closure, settled leases, and all three
  live enter phases that previously admitted the race.

## Validation and evidence

- `pnpm test src/main/session/worktree-transition/__tests__/resume-recovery.test.ts src/main/session/worktree-transition/__tests__/coordinator-observe.test.ts src/main/session/worktree-transition/__tests__/recovery.test.ts`
  — 3 files, 17 tests passed.
- `pnpm typecheck` passed.
- `pnpm test` — 492 files and 4,119 tests passed; one file and one test intentionally skipped.
- `git diff --check` passed.
- `bash scripts/file-level-review-expiry.sh` completed before this review.

## Residual risk

- The main-process listener requires an Agent Deck restart before an already-running installed app
  uses the fix. Restarting the app from this implementation session would terminate the session, so
  the exact installed-provider smoke trace was not replayed here.
- No README change is required because this restores the documented automatic transition contract
  without changing its public behavior.
