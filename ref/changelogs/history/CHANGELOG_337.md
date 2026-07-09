# CHANGELOG_337: Restore red error theme token for diff deletion rows

## Summary

Deleted rows in annotated `present_diff` PR cards now render their red background and marker color consistently.

## Changes

- Added the missing Tailwind theme token `--color-status-error`, matching the existing red status color.
- Added a renderer style regression test so `bg-status-error/...` and `text-status-error` utilities keep a real theme token.
- Recorded the repeated diff-color feedback in `ref/conventions/tally.md`.

## Validation

- `pnpm exec vitest run src/renderer/styles/globals.test.ts src/renderer/components/pending-rows/diff-review-presentation.test.tsx`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
