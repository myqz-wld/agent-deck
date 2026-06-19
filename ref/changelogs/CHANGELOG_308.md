# CHANGELOG_308: Final diff matches relative and absolute file paths

## Summary

Final diff now treats relative and absolute records for the same session file as the same file. This fixes the case where a file was first created under a relative path and then edited under an absolute path, causing final diff to show only the later edit.

## Changes

- Final diff filtering now normalizes each recorded file path through the session cwd before comparison.
- Initial create / final delete detection now also reads unified diff file headers, so it does not depend on one exact `changeKind` spelling.
- The initial-create final-diff regression test now covers a relative create followed by an absolute edit where `changeKind` is not already `add`.

## Validation

- `pnpm exec vitest run src/main/session/__tests__/final-file-diff.test.ts src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx`
- `pnpm typecheck`
- `git diff --check`
