# CHANGELOG_341: Move token accounting under today's summary

## Summary

Moved the Data tab token accounting note directly under today's summary and shortened it to the column inclusion rules.

## Changes

- Placed `Token 口径` below `今日汇总` so the accounting rules sit beside the totals they explain.
- Reworded the Claude Code note to state the total-input formula and that displayed reasoning is already part of output.
- Reworded the Codex note to state that cache read is already part of input and reasoning is already part of output.
- Updated the renderer test and README capability description for the new placement and wording.
- Recorded the UI-copy placement preference in `ref/conventions/tally.md`.

## Validation

- `pnpm exec vitest run src/renderer/components/__tests__/DataPanel.test.tsx`
- `pnpm typecheck`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
