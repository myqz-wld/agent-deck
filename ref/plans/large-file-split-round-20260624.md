---
plan_id: large-file-split-round-20260624
created_at: 2026-06-24
worktree_path: /Users/wanglidong/Repository/agent-deck
status: completed
base_commit: fcd21934f28069b0c27e0d9df89a66dd75e4596c
---

# Large File Split Round

## Goal And Invariants

Split approved large production source files without changing runtime behavior, public imports, or user-facing behavior.

Approved candidates:

- CS-001: `src/main/agent-deck-mcp/tools/schemas.ts`
- CS-002: `src/main/agent-deck-mcp/tools/handlers/spawn.ts`
- CS-003: `src/renderer/stores/session-store.ts`
- CS-004: `src/main/adapters/codex-cli/app-server/client.ts`
- CS-005: `src/main/session/manager.ts`

Explicit exclusion:

- CS-006: `src/main/agent-deck-mcp/__tests__/tools.test.ts` is deferred for a separate later session after user confirmation.

Invariants:

- Preserve existing public import paths where practical, especially `../schemas`, `./schemas`, `@main/session/manager`, and `@renderer/stores/session-store`.
- Keep singleton exports and handler exports stable.
- Move helper logic only; avoid behavior edits unless validation exposes a necessary mechanical fix.
- No lockfile, historical plan/log, or binary asset changes.

## Design Decisions

- `schemas.ts` became a compatibility facade over domain modules to avoid touching every handler import.
- `spawn.ts` kept `spawnSessionHandler` local and moved pre-handler helper clusters.
- `session-store.ts` kept Zustand store creation local and moved pure event merge and map helpers.
- `app-server/client.ts` kept exported client/thread classes local and moved config/notification helpers while preserving `__testables`.
- `session/manager.ts` kept public singleton and hook setter exports local and moved helper plumbing with low lifecycle risk.

## Completed Work

- Split `schemas.ts` into `schemas/shared.ts`, `schemas/spawn.ts`, `schemas/session.ts`, `schemas/retired.ts`, `schemas/tasks.ts`, and `schemas/issues.ts`.
- Split `spawn.ts` into `spawn-agent-resolver.ts`, `spawn-defaults.ts`, `spawn-limits.ts`, `spawn-prompt.ts`, and `spawn-team.ts`.
- Split `session-store.ts` into `session-store-events.ts` and `session-store-maps.ts`.
- Split `client.ts` into `protocol.ts`, `async-notification-queue.ts`, `thread-params.ts`, and `notification-helpers.ts`.
- Split `manager.ts` into `manager/hooks.ts`, `manager/explicit-user-message.ts`, and `manager/sdk-pending-claim.ts`, with `UpsertOptions` moved to `manager/_deps.ts` and re-exported from the public facade.

## Validation

- `pnpm typecheck`: passed.
- `pnpm test:node -- src/main/agent-deck-mcp/__tests__/tools.test.ts src/renderer/stores/__tests__/session-store.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/codex-cli/app-server/translate.test.ts src/main/session/__tests__/manager-ingest.test.ts src/main/session/__tests__/manager-public-api.test.ts`: passed.
- The focused vitest command collected the broader suite and reported `159 passed | 19 skipped` test files and `1723 passed | 293 skipped` tests. The skipped cases are the existing better-sqlite3 ABI guard under the system Node runtime.

## Review Closure

Deep review completed with the required heterogeneous pair:

- `reviewer-codex`: PASS, no CRITICAL/HIGH/MEDIUM/LOW findings.
- `reviewer-claude`: PASS, no CRITICAL/HIGH/MEDIUM/LOW findings; 3 INFO maintenance notes accepted as non-blocking.

Final review record: [REVIEW_140](../reviews/REVIEW_140.md).

Final changelog record: [CHANGELOG_326](../changelogs/CHANGELOG_326.md).
