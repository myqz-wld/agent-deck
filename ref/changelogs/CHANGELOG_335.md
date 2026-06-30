# CHANGELOG_335: Annotated present_diff keeps diff colors

## Summary

Annotated `present_diff` PR presentations now keep red/green diff cues while still showing line-anchored explanation cards.

## Changes

- Added line-level before/after comparison for the annotated PR rendering path.
- Marked deleted before-pane rows in red and added after-pane rows in green, with `-` / `+` markers.
- Kept annotation placement unchanged: `line: 0` remains before the first line, and numbered annotations still appear after their target line.
- Added regression coverage for annotated PR presentations retaining both deleted and added row tones.

## Validation

- `pnpm exec vitest run src/renderer/components/pending-rows/diff-review-presentation.test.tsx` (6 tests)
- `pnpm typecheck`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
