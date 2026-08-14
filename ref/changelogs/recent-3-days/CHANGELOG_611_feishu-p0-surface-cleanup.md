---
changelog_id: 611
changed_at: 2026-08-13
---

# CHANGELOG_611_feishu-p0-surface-cleanup: Remove dormant owner product surfaces

## Summary

Removed the unreachable Team and session-permissions product RPC chains before defining Feishu
owner grants, while retaining session collaboration, pending approvals, runtime controls, and the
trusted Agent/MCP team backend.

## Changes

### Product surface cleanup

- Removed the dormant Team renderer, Local IPC/preload CRUD facade, Remote Team facade, Core Team
  methods, capability metadata, and the dedicated Team resource-revision lane.
- Removed the unused `session.permissions.get` contract from Core through Remote preload after the
  Permissions page had already left the product.
- Moved live session presentation labels, session message reads/events, and summarizer diagnostics
  to neutral owners before deleting their former Team modules.
- Preserved session-scoped team metadata, Tasks, cross-session Messages, activity invalidation,
  pending permission responses, and runtime permission/sandbox controls.

### Persistence and compatibility

- Removed only the unreferenced `getWithMembers` and `findTeamEvents` read aggregates; no persisted
  team, member, message, task, or event row was deleted or migrated.
- Retained `agentDeckMessageRepo.listByTeam` and the complete Agent/MCP collaboration lifecycle.
- Removed the unsupported object-valued Codex `changeKind` fallback from its two readers while
  preserving all supported persisted, protocol, provider, rollback, and security compatibility.

## Validation

- Focused coverage passed 15 Electron files / 75 tests, 5 additional renderer/resource files / 41
  tests, and 2 Electron-native runtime/SQLite files / 14 tests.
- `pnpm typecheck`, `pnpm check:architecture`, and `pnpm build` passed.
- The full suite passed: 952 files passed, 2 skipped; 6,049 tests passed, 3 skipped.
- An isolated development instance rebuilt main/preload, initialized a fresh schema v62, listened
  on the isolated Hook port, and reached a healthy renderer before clean shutdown.
- `git diff --check` and exact removed-surface searches passed.

## Do Not Split Protection

No exception is required. Every changed production TypeScript/JavaScript file remains below 500
lines; the cleanup also deleted several obsolete oversized surface modules.

## Related review

- `ref/reviews/recent-3-days/REVIEW_247_feishu-p0-surface-cleanup.md`
