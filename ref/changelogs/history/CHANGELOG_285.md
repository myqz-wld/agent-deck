# CHANGELOG_285: filter no-op Codex file changes

## Summary

Codex file-change reporting now filters incomplete and no-op patch records before they reach the change list. This prevents SessionDetail from showing files that Codex reported but did not effectively modify.

## Changes

- Added shared Codex file-change helpers for patch status and effective diff detection.
- Codex app-server `fileChange` translation now skips:
  - explicit non-`completed` patch statuses;
  - update-like changes with empty diffs;
  - header-only diffs;
  - hunks that reconstruct to identical before/after content.
- `fileChangeRepo.listForSession` applies the same Codex no-op filter so historical polluted rows no longer appear in the change tab.
- Binary, rename, copy, mode, create, and delete diff signals are preserved even when they do not have parseable text hunks.

## Validation

- `pnpm exec vitest run src/shared/__tests__/codex-file-change.test.ts src/main/store/__tests__/file-change-repo.test.ts src/main/adapters/codex-cli/app-server/translate.test.ts src/main/session/__tests__/file-change-snapshots.test.ts src/main/session/__tests__/final-file-diff.test.ts`
- `pnpm typecheck`
- `git diff --check`
