# CHANGELOG_309: Final diff repairs historical null-before additions

## Summary

Final diff now treats explicit file-add records with a missing `before_snapshot` as an empty starting file. This fixes historical Codex add records that stored the created file in `after_snapshot` but left `before_snapshot` null, causing final diff to fall back to later local patches only.

## Changes

- Snapshot final diff now synthesizes an empty before snapshot for explicit initial add records and an empty after snapshot for explicit final delete records.
- File-change snapshot capture now records explicit Codex adds as empty-before snapshots even when the recorded diff is raw full-file content instead of unified diff text.
- Regression tests cover the `CHANGELOG_304.md` data shape: add record with `beforeSnapshot=null`, full `afterSnapshot`, followed by a later update.

## Validation

- `pnpm exec vitest run src/main/session/__tests__/final-file-diff.test.ts src/main/session/__tests__/file-change-snapshots.test.ts`
- `pnpm exec vitest run src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx`
- `pnpm typecheck`
