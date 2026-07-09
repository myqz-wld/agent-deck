# REVIEW_120 — hand_off_session archived team transfer failure

- Trigger: user-provided MCP error where `hand_off_session` spawned a successor, then failed mandatory transfer because `resourceTransfer.teams.failed` contained `reason: "team-archived"`.
- Scope: MCP handoff resource transfer, handoff result shape, and focused handoff tests.
- Method: deterministic source inspection plus targeted regression tests. This was a narrow lifecycle bug, so no adversarial reviewer pair was spawned.
- Related changelog: [CHANGELOG_282.md](../../changelogs/history/CHANGELOG_282.md).

## Decisions

1. **MED fixed: archived team membership was treated as fatal handoff transfer failure**
   - Evidence: `transferTeams` now classifies archived teams into `skipped` at [resource-transfer-coordinator.ts](/Users/wanglidong/Repository/agent-deck/src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts:122) and returns that diagnostic in the successful team transfer result at [resource-transfer-coordinator.ts](/Users/wanglidong/Repository/agent-deck/src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts:217).
   - Fix: add `resourceTransfer.teams.skipped` to the result type at [schemas.ts](/Users/wanglidong/Repository/agent-deck/src/main/agent-deck-mcp/tools/schemas.ts:727), skip archived teams without reviving or transferring them, and preserve active-team fatal failures.

2. **LOW fixed: missing regression coverage for stale archived membership rows**
   - Evidence: added archived-only and mixed archived+active tests at [hand-off-session.resource-transfer.test.ts](/Users/wanglidong/Repository/agent-deck/src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts:120) and [hand-off-session.resource-transfer.test.ts](/Users/wanglidong/Repository/agent-deck/src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts:150).
   - Fix: tests assert no `swapLead` or `addMember` call for archived-only handoff and assert active teams still transfer while archived memberships are reported in `skipped`.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts` passed: 13 tests.
- `pnpm typecheck` passed.

## Residual Risk

- `taskRepo.reassignOwner(..., { policy: "preserve-team" })` still preserves `team_id` for tasks owned by the caller before team transfer runs. This fix addresses the observed fatal handoff failure only; changing task policy for archived team-bound tasks would be broader behavior work.

