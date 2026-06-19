# CHANGELOG_303 - Related session listing and SessionDetail tasks

## Summary

- `list_sessions` now defaults to caller-related sessions for real session callers instead of returning unrelated app-wide active sessions.
- Related sessions include the caller, spawn ancestors / descendants, and sessions sharing an active team membership.
- External read-only `__external__` discovery and explicit `spawnedByFilter` recovery searches remain broad and now support `offset` + `limit` pagination so reset/rescue workflows can page through stranded sessions.
- Added `offset` and `hasMore` to `list_sessions`; filtering is applied before the output page is sliced.
- `spawnedByFilter` and `adapterFilter` are pushed into live/history session repo queries instead of relying on handler-only JS filtering.
- `adapterFilter` remains optional with no default, which means all adapters are included unless specified.
- Added v034 partial composite indexes for live/history session list filter shapes: adapter, spawnedBy, and adapter+spawnedBy with `last_event_at` ordering.
- Added focused `list_sessions` regression coverage for hiding unrelated sessions, preserving adapter filtering inside the related scope, keeping explicit `spawnedByFilter` broad, and paging explicit rescue searches.
- SessionDetail now has a read-only Tasks tab after Activity and before Changes.
- The Tasks tab uses the selected session's MCP-style visible task scope: own personal tasks plus active-team tasks visible to that session.
- The Tasks tab uses status tabs for "未完成" and "已完成"; unfinished tasks remain the default view.
- Added `session:list-tasks` IPC and preload facade wiring, reusing existing `TaskChanged` events for refreshes.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` (78 tests)
- `pnpm test src/main/store/__tests__/v034-migration.test.ts` (2 tests, Electron-as-node SQLite binding)
- `pnpm typecheck`
- `git diff --check`
