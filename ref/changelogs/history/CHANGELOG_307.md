# CHANGELOG_307: Final diff preserves whole-file create/delete state

## Summary

The Changes page final diff now preserves the first create and final delete semantics. If a file was created during the session, final diff emits a whole-file addition from `/dev/null`; if a file was deleted by the final state, final diff emits a whole-file deletion to `/dev/null`.

## Changes

- Final diff generation detects initial text file creation from Claude Write records and Codex add/create metadata.
- Final diff generation detects final text file deletion from Codex delete/remove metadata.
- Snapshot-generated final diffs now include `new file mode` / `deleted file mode` plus `/dev/null` headers when appropriate.
- README Diff Rendering documentation notes that final diff preserves initial create and final delete state.

## Validation

- `pnpm exec vitest run src/main/session/__tests__/final-file-diff.test.ts src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx`
- `pnpm typecheck`
- `git diff --check`
