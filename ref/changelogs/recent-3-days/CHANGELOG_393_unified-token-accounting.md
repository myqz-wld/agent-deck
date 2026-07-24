---
changelog_id: 393
changed_at: 2026-07-24
---

# CHANGELOG_393_unified-token-accounting: Unify token accounting in the Data tab

## Summary

Present token usage as a single ledger: input and output are the primary totals, while cache and
reasoning values are visibly marked as included breakdowns.

## Changes

### Unified accounting

- Add `inputTotalTokens` to daily usage rows and normalize input totals by adapter in the storage
  query: Claude adds prompt-cache fields, while Codex and Grok retain their inclusive input value.
- Keep output totals inclusive of reasoning and expose the existing cache/reasoning fields as
  breakdowns rather than peer totals.

### Data tab presentation

- Replace provider-specific accounting paragraphs with compact input/output total cards and one
  shared rule explaining which values are included.
- Group the daily table into input/output sections, label breakdown columns with “included”, and
  show zero values explicitly so unavailable fields are not confused with missing data.

## Validation

- `pnpm typecheck` passed.
- Renderer tests passed: 10 tests across the Data panel and startup preload suites.
- Electron-as-node token repository tests passed: 13 tests.
- `git diff --check` passed.

## Do Not Split Protection

- `src/renderer/components/DataPanel.tsx` remains below the 500-line production source guardrail.
