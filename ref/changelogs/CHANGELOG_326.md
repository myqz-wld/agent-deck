# CHANGELOG_326: Split Large Production Files Into Focused Modules

## Summary

Five large production source files were split into smaller focused modules without changing runtime behavior or public import paths.

## Scope

- Split `src/main/agent-deck-mcp/tools/schemas.ts` into a compatibility facade plus domain schema modules under `tools/schemas/`.
- Split `src/main/agent-deck-mcp/tools/handlers/spawn.ts` into focused spawn helper modules for agent resolution, defaults, limits, prompt context, and team membership cleanup.
- Split `src/renderer/stores/session-store.ts` by moving pure event merge and map bucket helpers into sibling modules.
- Split `src/main/adapters/codex-cli/app-server/client.ts` by extracting protocol types, async notification queue handling, thread parameter builders, and notification helpers.
- Split `src/main/session/manager.ts` by extracting hook state, explicit user-message checks, and SDK pending-claim helpers.
- Preserved facade imports including `../schemas`, `@main/session/manager`, and `@renderer/stores/session-store`.

## Line Count Outcome

- `tools/schemas.ts`: 11 lines; new schema modules are 8-327 lines.
- `tools/handlers/spawn.ts`: 491 lines; new helper modules are 10-132 lines.
- `renderer/stores/session-store.ts`: 485 lines; new helper modules are 53-74 lines.
- `codex-cli/app-server/client.ts`: 468 lines; new helper modules are 33-164 lines.
- `session/manager.ts`: 497 lines; new helper modules are 7-34 lines.

## Explicit Deferral

`src/main/agent-deck-mcp/__tests__/tools.test.ts` remains intentionally deferred as a separate large test-file split candidate.

## Validation

- `pnpm typecheck` passed.
- `pnpm test:node -- src/main/agent-deck-mcp/__tests__/tools.test.ts src/renderer/stores/__tests__/session-store.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/codex-cli/app-server/translate.test.ts src/main/session/__tests__/manager-ingest.test.ts src/main/session/__tests__/manager-public-api.test.ts` passed.
- The focused vitest command collected the broader suite and reported `159 passed | 19 skipped` test files and `1723 passed | 293 skipped` tests. The skipped cases are the existing better-sqlite3 ABI guard under the system Node runtime.

## Review

See [REVIEW_140](../reviews/REVIEW_140.md).
