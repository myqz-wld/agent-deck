# CHANGELOG_306: Whole-file diff backgrounds

## Summary

The Changes page now renders whole-file text additions and deletions as full-panel green and red views instead of relying on the normal side-by-side Monaco diff styling.

## Changes

- Text diff rendering detects whole-file add/delete payloads from direct snapshots.
- Unified diff metadata such as `new file mode`, `deleted file mode`, `/dev/null`, or Codex `changeKind` also maps to the full-panel add/delete views.
- Delete entries now get a visible `删除` badge beside the file path.
- README Diff Rendering documentation notes the whole-file green/red panels.

## Validation

- `pnpm exec vitest run src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx`
- `pnpm typecheck`
- `git diff --check`
