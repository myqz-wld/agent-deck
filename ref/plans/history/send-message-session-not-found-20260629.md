---
plan_id: send-message-session-not-found-20260629
status: completed
created: 2026-06-29
completed: 2026-06-29
base_branch: main
base_commit: 48e244842e41fca675c994d775e1a93b59ef31f4
worktree_path: /Users/wanglidong/Repository/agent-deck
related_changelog: CHANGELOG_334
related_review: REVIEW_142
---

# send_message Session Not Found Fix

## Goal And Invariants

Fix issue `817ddcfa-39f6-49a9-81dd-4dbcdcb17094`: `send_message` must accept an active Agent Deck session target when the caller has either the canonical application id or the current SDK/thread alias for that same session.

Invariants:
- Do not broaden write access beyond existing `send_message` rules: target must exist, self-send stays rejected, explicit teamId must be a shared active team, and teamless DM semantics remain unchanged.
- `send_message` must canonicalize target identity before shared-team checks, reply pair checks, enqueue, and the success payload.
- Preserve existing read-only external caller restrictions.
- Keep Claude/Codex bundled protocol semantics aligned; no prompt asset change was needed.

## Design Decisions

- Root cause class: target lookup used only `sessions.id`, while runtime session identity can also be represented by `sessions.cli_session_id`.
- Fix location: keep the change in `send_message` because this issue is a write-path target resolution failure, not a broader read-projection change.
- Authorization remains canonical: after alias resolution, all team checks and message rows use `target.id`.

## Tasks

| Task | Owner | Status | Dependencies | Validation |
|------|-------|--------|--------------|------------|
| Inspect `send_message`, `list_sessions`, and session id resolution paths | Codex | completed | none | Source inspection |
| Identify why valid active targets can be missed by `send_message` | Codex | completed | inspection | `sessions.id` vs `cli_session_id` evidence |
| Implement minimal fix and regression tests | Codex | completed | root cause | Focused vitest |
| Update changelog/review records as required | Codex | completed | implementation | CHANGELOG_334 / REVIEW_142 |
| Run validation and mark issue status via MCP | Codex | completed | tests/docs | Vitest + typecheck |

## Progress And Validation

Completed:
- Read repository workflow `CLAUDE.md`.
- Read Codex MCP/runtime conventions at `resources/codex-config/CODEX_AGENTS.md`.
- Read `complex-plan-workflow` skill.
- Compared `send_message`, `list_sessions`, `get_session`, session repo row mapping, team membership queries, and wire-prefix semantics.
- Added `send_message` target alias resolution with canonical id propagation.
- Added regression coverage in `src/main/agent-deck-mcp/__tests__/tools.test.ts`.
- Added `ref/changelogs/CHANGELOG_334.md` and `ref/reviews/REVIEW_142.md`.

Validation:
- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` passed: 87 tests.
- `pnpm typecheck` passed.
- `git diff --check` passed.

Residual risks:
- This fix intentionally canonicalizes only the target side of `send_message`. Caller identity is still owned by the existing MCP token / guard path.
- The report mentions `list_sessions` returning the active session. The implemented guard covers alias drift that can still present as a valid active runtime session id to the caller.

## Next-Session First Action

No follow-up implementation is required for this plan. If the issue reopens, inspect live MCP auth resolution and compare the worker's `ctx.caller.callerSessionId`, requested `sessionId`, canonical `sessions.id`, and `cli_session_id` values from the same app process.
