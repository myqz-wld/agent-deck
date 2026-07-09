# CHANGELOG_300: Quota percentages render as integers

## Summary

The Data tab quota window now renders provider usage percentages as integer percentages, so values such as `0.0%` or `0.4%` display as `0%`.

## Changes

- Updated the quota percentage formatter in `DataPanel`.
- Added a DataPanel regression assertion for fractional low usage.

## Validation

- `pnpm exec vitest run src/renderer/components/__tests__/DataPanel.test.tsx`
- `pnpm typecheck`
