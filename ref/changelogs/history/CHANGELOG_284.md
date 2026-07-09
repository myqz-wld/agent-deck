# CHANGELOG_284: split active-team membership query semantics

## Summary

Agent Deck now has separate team membership repo queries for row-active membership history and operational active-team scope. Handoff and task paths use the operational query, so archived teams are filtered in one SQL boundary instead of by repeated call-site probes.

## Changes

- Added `findActiveTeamMembershipsBySession(sessionId)` to the team repo interface and facade.
- Kept `findActiveMembershipsBySession(sessionId)` as the row-active query that returns `left_at IS NULL` membership rows even when the team is archived.
- Moved task permission and visible-scope filtering to the new operational query.
- Moved `hand_off_session` transfer candidates to the new operational query while preserving row-active diagnostics for `resourceTransfer.teams.skipped`.
- Added regression tests for archived-team ghost memberships in the repo, handoff transfer, and task handler paths.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts src/main/agent-deck-mcp/__tests__/task-crud.test.ts src/main/agent-deck-mcp/__tests__/task-events.test.ts`
- `pnpm test src/main/store/__tests__/agent-deck-team-repo.test.ts`
- `pnpm typecheck`
