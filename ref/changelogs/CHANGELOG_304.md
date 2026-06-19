# CHANGELOG_304: Preload quota snapshots before opening Data tab

## Summary

Fixed a regression where provider quota data was only populated in the renderer after opening the Data tab. App startup now preloads provider usage snapshots into the renderer token-usage store again, so the first Data tab visit can render the quota window from already-loaded state.

## Changes

- Added `useStartupDataPreload()` and moved App startup daily-token prefetch into it.
- Restored App startup `providerUsageSnapshot()` prefetch and store hydration.
- DataPanel now has regression coverage for using startup-preloaded quota snapshots without a first-open provider IPC read.
- Main provider-usage cache TTL now matches the 5-minute renderer refresh cadence, expiring 5 seconds before the next scheduled refresh.

## Validation

- `pnpm exec vitest run src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx src/renderer/components/__tests__/DataPanel.test.tsx src/main/ipc/__tests__/provider-usage.test.ts`
- `pnpm typecheck`
- `git diff --check`
