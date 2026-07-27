---
changelog_id: 399
changed_at: 2026-07-27
---

# CHANGELOG_399_data-token-summary-alignment: Align the daily token summary

## Summary

The Data tab's daily token summary now follows the same open section hierarchy as its neighboring
quota, live-rate, and detail sections instead of appearing inside an additional framed container.

## Changes

### Data tab presentation

- Remove the rounded border, tinted background, padding, and nested frame from the complete
  `今日 Token` section so its heading aligns with the other Data tab headings.
- Keep the input and output totals in the same lightweight filled cards used elsewhere, with
  spacing adjusted to match the quota cards.
- Render the accounting rule as muted inline helper text instead of a second nested box.

### Regression coverage

- Assert that the daily summary section remains free of outer rounded and border classes and keeps
  the shared heading spacing.

## Validation

- `pnpm exec vitest run src/renderer/components/__tests__/DataPanel.test.tsx` passed 7 tests.
- `pnpm typecheck` passed.
- `pnpm test` passed 373 files and 3,119 tests; one credentialed smoke test remained skipped.
- A mocked local DataPanel preview was visually checked at 2048 × 900, including section alignment,
  hierarchy, and table transition.
- `git diff --check` passed.

## Do Not Split Protection

`src/renderer/components/DataPanel.tsx` remains below the 500-line production source guardrail at
467 lines.

## Notes

This is a renderer-only visual adjustment with no copy, accounting, data, or startup behavior
change, so no README update or application restart is required.
