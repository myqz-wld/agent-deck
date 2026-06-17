---
plan_id: handoff-active-team-membership-api-20260618
created_at: 2026-06-18
status: completed
base_commit: 16ed6084a6d4b46f5afe2d9b28afa53bd2e2322a
worktree_path: /Users/wanglidong/Repository/agent-deck
---

# Active Team Membership API Optimization

## Goal

Split Agent Deck team membership query semantics so callers can choose between row-active membership history and operational memberships whose teams are not archived, then use the operational API in handoff/task paths.

## Invariants

- `findActiveMembershipsBySession` keeps row-active semantics: `left_at IS NULL`, including archived teams. Session revive and history coordination can still see ghost membership rows.
- `findActiveTeamMembershipsBySession` filters `agent_deck_teams.archived_at IS NULL` and is safe for task visibility, task permission checks, and handoff team transfer candidates.
- `hand_off_session` keeps `resourceTransfer.teams.skipped` diagnostics for archived teams and preserves fatal behavior for missing active teams or transfer failures.
- No archive/unarchive behavior changes: if an archived team is later unarchived, the preserved row-active membership becomes visible again through the operational query.

## Non-Goals

- Do not automatically revive archived teams during handoff.
- Do not change task reassignment policy for archived team-bound tasks.
- Do not change prompt assets.

## Completed Work

- Added `findActiveTeamMembershipsBySession` to the team repo interface, facade, member-query implementation, and test mocks.
- Added SQLite coverage proving row-active and active-team query semantics differ after a team is archived.
- Switched task helper membership checks and visible task scope to the operational query.
- Switched handoff team transfer candidates to the operational query while retaining row-active diagnostics for skipped archived teams.
- Updated handoff/task tests to model the new query boundary.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts src/main/agent-deck-mcp/__tests__/task-crud.test.ts src/main/agent-deck-mcp/__tests__/task-events.test.ts` passed: 60 tests.
- `pnpm test src/main/store/__tests__/agent-deck-team-repo.test.ts` passed: 32 tests.
- `pnpm typecheck` passed.
- `git diff --check` passed for touched source/test files before record creation.

## Related Records

- [CHANGELOG_284.md](../changelogs/CHANGELOG_284.md)
- [REVIEW_121.md](../reviews/REVIEW_121.md)
