# CHANGELOG_305: Refresh quota snapshots outside the Data tab

## Summary

Provider quota snapshots now keep refreshing every five minutes from the App-level preload hook even when the Data tab is not open. The Data tab reuses the shared renderer store and no longer owns a separate automatic quota refresh timer.

## Changes

- App-level `useStartupDataPreload()` now schedules the recurring provider quota refresh.
- DataPanel still does a one-shot stale-cache recovery when opened and keeps the manual hard refresh button.
- Removed the DataPanel-owned automatic provider timer to avoid duplicate background reads.
- Added regression coverage for background refresh while DataPanel is unmounted.

## Validation

- `pnpm exec vitest run src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx src/renderer/components/__tests__/DataPanel.test.tsx src/main/ipc/__tests__/provider-usage.test.ts`
- `pnpm typecheck`
- `git diff --check`
