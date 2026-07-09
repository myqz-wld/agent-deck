---
plan_id: handoff-archived-team-transfer-20260618
created_at: 2026-06-18
status: completed
base_commit: 7a1b850bcd71b8cd645b218f20284c2923cefaca
worktree_path: /Users/wanglidong/Repository/agent-deck
---

# hand_off_session Archived Team Transfer Fix

## Goal

Fix `hand_off_session` so a caller's stale active membership in an already archived team does not make mandatory resource transfer fail after the successor session is spawned.

## Invariants

- Worktree marker and task reassignment remain mandatory; failures still abort handoff and close the spawned successor.
- Active team transfer remains mandatory; `team-not-found`, `swapLead`, `addMember`, and rollback failures still abort handoff.
- Archived teams are not revived and are not transferred to the successor.
- The handoff result should keep enough diagnostic detail to explain skipped archived teams.
- Changes stay scoped to MCP handoff resource transfer and regression tests unless evidence shows the repo query contract must change.

## Non-Goals

- Do not change global `agentDeckTeamRepo.findActiveMembershipsBySession` semantics in this fix.
- Do not alter team archive, unarchive, scheduler, or message dispatch behavior.
- Do not change prompt assets unless the result shape or user-visible protocol changes require it.

## Evidence And Decisions

- User-provided failure shows `resourceTransfer.teams.failed=[{ reason: "team-archived" }]`, which made `resourceTransferFailed()` abort the handoff and close the spawned successor.
- `resource-transfer-coordinator.ts` listed all caller memberships, probed each team, pushed archived teams into fatal `failed`, and returned `status: "failed"` before transferring any active candidates.
- `findSharedActiveTeams` and task helpers already treat archived teams as inactive, while handoff transfer has a local probe that can report per-team diagnostics.
- Decision: keep transfer-layer handling and add a non-fatal `teams.skipped` bucket for archived teams. This preserves mandatory failure semantics for active teams and makes stale archived memberships visible in the successful handoff payload.

## Checklist

- [x] Read repository workflow and related Agent Deck runtime conventions.
- [x] Inspect handoff transfer implementation and tests.
- [x] Create durable plan.
- [x] Add `teams.skipped` result field and treat `team-archived` as skipped, not failed.
- [x] Add regression coverage for archived-only and mixed archived+active memberships.
- [x] Run targeted handoff tests.
- [x] Run `pnpm typecheck`.
- [x] Add final changelog/review record and update indexes.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts` passed: 13 tests.
- `pnpm typecheck` passed.
- `git diff --check` passed.

## Risks

- Adding a `skipped` field changes the result payload shape, but only additively. Existing callers that read `status`, `transferred`, or `failed` continue to work.
- If caller owns team-bound tasks for an archived team, `preserve-team` task reassignment will still preserve that `team_id`. This fix only addresses the immediate fatal handoff failure; changing task policy would be a broader behavior decision.

## Next-Session First Action

No next-session action remains. If a follow-up is opened, start by deciding whether archived team-bound tasks should be cleared, skipped, or preserved during `hand_off_session`.

