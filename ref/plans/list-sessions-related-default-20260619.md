---
plan_id: list-sessions-related-default-20260619
created_at: 2026-06-19
worktree_path: /Users/wanglidong/Repository/agent-deck
status: completed
base_commit: 8c8066b754419f8f9310495275c799ba8bc96d92
base_branch: main
related_changelog: CHANGELOG_303
---

# Goal

Change MCP `list_sessions` so a real Agent Deck session caller sees only related sessions by default, not unrelated active sessions from the whole app. Also add a SessionDetail Tasks tab after Activity and before Changes that shows the selected session's related tasks with status tabs; unfinished tasks are the default view.

# Invariants

- Default narrowing applies to real session callers.
- Related sessions include the caller, sessions connected by spawn ancestry, and sessions sharing an active team membership.
- External read-only `__external__` discovery remains app-wide because it has no caller relation to apply.
- Explicit `spawnedByFilter` remains a recovery/search escape hatch and must continue to work for lead-reset rescue flows.
- `list_sessions` has `offset` + `limit` pagination; explicit rescue filters page after filtering, not before.
- `list_sessions` returns `hasMore` and keeps `adapterFilter` unset by default, meaning all adapters.
- Explicit `adapterFilter` and `spawnedByFilter` are applied in session repo queries before output pagination.
- `get_session` behavior is out of scope for this focused user report unless tests prove it must change.
- SessionDetail task display is read-only; task writes stay in the existing MCP task tools.
- SessionDetail task visibility mirrors MCP `task_list` default visibility: own personal tasks plus active-team tasks visible to that session.
- The task store physically deletes deleted tasks today, so SessionDetail distinguishes unfinished vs completed tasks rather than showing deleted-task history.

# Checklist

- [x] Read repository workflow, Codex session conventions, and relevant MCP/list-session history.
- [x] Record the user feedback in `ref/conventions/tally.md`.
- [x] Add the related-session default filter in `list_sessions`.
- [x] Add SessionDetail read-only Tasks tab after Activity and before Changes.
- [x] Split tasks into "未完成" / "已完成" tabs.
- [x] Update MCP schema/tool descriptions and README behavior docs.
- [x] Add regression coverage for hidden unrelated sessions and preserved explicit recovery filters.
- [x] Add `offset` pagination and `hasMore` to `list_sessions`, and cover explicit rescue paging.
- [x] Push explicit `spawnedByFilter` into live/history session repo queries.
- [x] Push explicit `adapterFilter` into live/history session repo queries.
- [x] Add v034 session list filter indexes and migration coverage.
- [x] Run focused tests and typecheck.
- [x] Archive the final changelog/plan records.

# Current Evidence

- `src/main/agent-deck-mcp/tools/handlers/list.ts` previously listed active/dormant/history sessions from `sessionRepo` and only applied lifecycle, adapter, and `spawnedByFilter`; it ignored caller relation.
- `LIST_SESSIONS_SCHEMA.statusFilter` defaults to `active`, but that was lifecycle-only and did not prevent unrelated active sessions from appearing.
- Before this fix, `list_sessions` had `limit` but no `offset`, so "broad" recovery searches were not pageable.
- `spawnedByFilter` and `adapterFilter` previously ran in the handler after a candidate page; they are now passed into session repo live/history reads.
- v034 adds partial composite indexes for live/history list query shapes using adapter, spawnedBy, and adapter+spawnedBy filters with `last_event_at` ordering.
- Existing reviewer fallback prompts call `list_sessions({ statusFilter: 'active' })` to find a lead; narrowing this default to related sessions improves that fallback instead of making it noisier.
- SessionDetail tabs previously ordered Activity -> Changes -> Summary -> Cross-session -> Permissions. The new Tasks tab is inserted between Activity and Changes.
- TasksPanel uses "未完成" / "已完成" tabs because tasks do not have soft-delete records.
- `TaskChangedEvent` already exists and is bridged to renderer; TasksPanel subscribes and refreshes without adding new write paths.

# Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts`: passed, 78 tests.
- `pnpm test src/main/store/__tests__/v034-migration.test.ts`: passed, 2 tests.
- `pnpm typecheck`: passed.
- `git diff --check`: passed.

# Risks

- Filtering after a small SQL page could drop related sessions behind many unrelated recent sessions. The implementation fetches a larger bounded candidate set before filtering and slicing.
- Over-narrowing explicit `spawnedByFilter` could break lead-reset rescue flows; this filter remains an explicit broad search path.
- External clients have no real session identity, so default related filtering does not apply to `__external__`.
- Session task visibility must not accidentally show all tasks; the IPC uses `visibleScope` with the selected session's active team ids and own personal scope.

# Next-session First Action

No follow-up session required unless runtime testing finds a task visibility or session-discovery edge case.
