---
changelog_id: 426
changed_at: 2026-07-31
---

# CHANGELOG_426_exit-worktree-output-schema-compatibility: Publish a callable exit_worktree result schema

## Summary

`exit_worktree` now publishes one MCP object output schema that the pinned MCP SDK can list and
validate. Both accepted-restoration and completed-cleanup results retain their original strict
cross-field contract without triggering an internal Zod `_zod` exception after the handler
returns.

## Changes

- Replace the top-level discriminated union with one strict object schema whose `state`,
  `effectiveFrom`, and optional `worktreeRemoved` fields describe both success variants.
- Retain exact runtime pairing rules through Zod cross-field validation:
  `waiting-tool-result` requires `automatic-next-turn` and omits `worktreeRemoved`, while
  `completed-cleanup` requires `already-effective` and a boolean `worktreeRemoved`.
- Preserve a discriminated TypeScript result type for handler compile-time checks.
- Add a real MCP SDK in-memory registration test that checks `tools/list` publication and invokes
  the tool through `tools/call`.

## Validation

- Focused MCP scope: 3 files and 106 tests passed.
- Full Electron-ABI suite: 439 files passed and 1 skipped; 3,646 tests passed and 1 skipped.
- `pnpm typecheck`, `pnpm build`, `bash scripts/logger-check.sh`,
  `bash scripts/file-level-review-expiry.sh`, and `git diff --check` passed.
- The prompt-asset inventory and manifest-backed pre-edit backup were verified by SHA-256.

## Notes

- The current Electron main process cannot hot-reload this schema. An already accepted
  `exit_waiting_tool_result` transition remains durable; restart onto this build, then retry
  `exit_worktree` so the provider can observe the validated result and complete restoration.
