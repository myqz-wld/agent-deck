---
changelog_id: 420
changed_at: 2026-07-31
---

# CHANGELOG_420_archive-plan-dead-code-removal: Remove the retired archive plan MCP chain

## Summary

Remove the unregistered `archive_plan` tool and every orphaned implementation path that existed
only to support it. Active session archive behavior remains owned by handoff finalization and UI
session actions; worktree lifecycle remains independent from branch and plan cleanup.

## Changes

### Remove the retired tool

- Delete the archive handler, phased implementation, plan-path resolution, fast-forward merge,
  worktree/branch cleanup, plan-index mutation, and their dedicated tests.
- Remove archive input/output schemas, tool-name guard keys, external-caller allowlist entries,
  HTTP observability classification, failure-event display variants, and compatibility assertions.
- Remove the archive-only caller-cwd resolver.

### Remove the orphaned baton cleanup escape hatch

- Delete `runBatonCleanup`, `shutdown_baton_teammates`, and
  `shutdownTeammatesOnBaton` after confirming that no active production handler imports them.
- Delete their dedicated tests and retired MCP schemas.
- Keep current `hand_off_session` mandatory resource transfer intact; it no longer uses this
  legacy cleanup chain.

### Clarify active lifecycle contracts

- Rename `tools/schemas/retired.ts` to `tools/schemas/lifecycle.ts`; the module now contains only
  active `hand_off_session`, `enter_worktree`, and `exit_worktree` contracts.
- Trim archive-only filesystem helpers from the shared worktree implementation dependencies.
- Rewrite current marker, recovery, archive-error, and handoff comments so they describe active
  structured transition and ownership-transfer behavior.
- Preserve the applied v020 migration and historical ref documents without rewriting their
  original context.

## Validation

- `pnpm typecheck`
- Focused MCP schema, caller-authentication, observability, handoff, and worktree tests
  (9 files, 105 tests)
- `pnpm test` (478 files passed, 1 skipped; 3,919 tests passed, 1 skipped)
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`
- Active source scan confirms no retired archive/baton identifiers remain outside the immutable
  v020 migration.

## Do Not Split Protection

Every changed production source file is at or below 500 lines.

## Notes

- No database migration is required.
- The removed MCP tool was already absent from `buildAgentDeckTools`; this change removes only dead
  compatibility code and stale metadata.
- Prompt/schema assets were backed up under
  `.prompt-asset-improver/local/backups/20260731T070828Z/` before editing.
