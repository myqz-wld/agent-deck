# REVIEW_121 — active-team membership query split

- Trigger: follow-up optimization after [CHANGELOG_282](../../changelogs/history/CHANGELOG_282.md), where archived team rows were skipped at handoff transfer time but call sites still mixed row-active and operational membership semantics.
- Scope: team repo membership queries, MCP handoff resource transfer, task helper membership checks, typed mocks, and focused regression tests.
- Method: deterministic source inspection plus targeted regression tests. This was a narrow refactor over the previous archived-team handoff fix, so no adversarial reviewer pair was spawned.
- Related changelog: [CHANGELOG_284.md](../../changelogs/history/CHANGELOG_284.md).

## Decisions

1. **MED fixed: row-active and operational active-team semantics were collapsed into one helper name**
   - Evidence: `findActiveMembershipsBySession` intentionally preserves `left_at IS NULL` ghost rows for archived teams, while task and handoff paths need only non-archived teams.
   - Fix: added `findActiveTeamMembershipsBySession` with an `INNER JOIN agent_deck_teams` and `t.archived_at IS NULL`, then switched task helpers and handoff candidate selection to that method.

2. **LOW fixed: archived-team diagnostics still need row-active membership rows**
   - Evidence: if handoff only used the operational query, archived memberships would silently disappear from `resourceTransfer.teams.skipped`.
   - Fix: handoff now reads row-active memberships for diagnostics and active-team memberships for transfer candidates. Row-active memberships absent from the active-team set are classified as `team-archived`, `team-not-found`, or `active-team-query-mismatch`.

3. **LOW fixed: revive semantics stay explicit**
   - Evidence: preserving row-active ghost rows means unarchiving a team can make the same membership visible to the operational query again without rewriting membership rows.
   - Fix: documented the split in the archived plan and covered the query difference in the SQLite repo test.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts src/main/agent-deck-mcp/__tests__/task-crud.test.ts src/main/agent-deck-mcp/__tests__/task-events.test.ts` passed: 60 tests.
- `pnpm test src/main/store/__tests__/agent-deck-team-repo.test.ts` passed: 32 tests.
- `pnpm typecheck` passed.

## Residual Risk

- `findActiveMembershipsBySessionIds` still has row-active semantics. Current task/handoff changes do not depend on that batch query; changing it would be a broader UI/session-enrichment decision.
