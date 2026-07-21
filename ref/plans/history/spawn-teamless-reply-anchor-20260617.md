---
plan_id: "spawn-teamless-reply-anchor-20260617"
created_at: "2026-06-17"
worktree_path: "/Users/wanglidong/Repository/agent-deck"
status: "completed"
base_branch: "main"
related_changelog: "CHANGELOG_279"
related_review: "REVIEW_119"
completed_at: "2026-06-17"
---

# Spawn Teamless Reply Anchor

## Goal

Fix `spawn_session` standalone sessions so non-team children can communicate back to the spawning session immediately and render under their parent in SessionList without waiting for later activity.

## Invariants

- Normal `spawn_session` remains a parent-child dispatch relationship and still writes `sessions.spawned_by` unless `handOffMode=true`.
- `hand_off_session` remains excluded from spawn links and does not receive reply-to-original-lead instructions through this helper path.
- A spawned session receives enough first-turn context to call `send_message` back to the actual caller: lead session id, `replyToMessageId`, and whether to omit `teamId`.
- The placeholder message id returned as `spawnPromptMessageId` matches the id embedded in the child prompt.
- Team spawns include `teamId`; standalone spawns use teamless DM with `teamId=null` and omit `teamId` from the send example.
- UI freshness for spawn links does not depend on later SDK events.

## Design Decisions

- Reuse the existing wire prefix plus lead context block for standalone spawns, extending it to support `teamId=null`.
- Insert the placeholder message for standalone spawns with `teamId=null`, relying on the existing teamless DM reply pair-scope validation.
- Keep the placeholder insert after `createSession` for this scoped fix; the known pre-existing placeholder timing follow-up is not expanded here.
- After a successful `setSpawnLink`, emit `session-upserted` for the child record so the renderer sees `spawnedBy` immediately.

## Completed Checklist

- [x] Update lead context block types and copy for nullable team id.
- [x] Change spawn handler to inject wire prefix and placeholder for all caller-owned normal spawns.
- [x] Emit child `session-upserted` after successful spawn-link write.
- [x] Update focused tests for team and standalone spawn prompt/placeholder behavior.
- [x] Run focused tests and typecheck.
- [x] Add changelog/review records for this bug fix.

## Validation

- `pnpm test src/main/agent-deck-mcp/__tests__/lead-context-block.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts` passed.
- `pnpm typecheck` passed.

## Outcome

Standalone spawned children now start with `[msg <spawnPromptMessageId>][sid <leadSid>]`, a context block that tells them to omit `teamId`, and a delivered placeholder row with `teamId=null`. The parent-child row also reaches the renderer immediately through `session-upserted` after `setSpawnLink`.
