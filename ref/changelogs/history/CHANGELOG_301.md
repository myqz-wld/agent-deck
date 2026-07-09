# CHANGELOG_301: Quota refresh is less aggressive and supports hard refresh

## Summary

The Data tab provider quota window now refreshes automatically every 5 minutes instead of every minute, and exposes a manual refresh button for on-demand hard refresh.

## Changes

- Lowered renderer-side provider quota polling frequency to reduce Claude/Codex usage endpoint pressure.
- Added a Data tab `刷新` button that sends `{ force: true }` through preload and IPC.
- Updated the main-side provider usage handler so forced reads bypass the fresh TTL cache while concurrent refreshes remain deduped.
- Added regression coverage for manual hard refresh and cache bypass behavior.

## Validation

- `pnpm exec vitest run src/main/ipc/__tests__/provider-usage.test.ts src/renderer/components/__tests__/DataPanel.test.tsx`
- `pnpm typecheck`
- `pnpm build`
