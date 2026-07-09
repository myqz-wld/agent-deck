# CHANGELOG_299: Reuse the Codex quota background app-server

## Summary

Fixed Codex quota reads when no Codex session is open. Agent Deck still starts a silent background Codex app-server probe, but it now reuses a short-lived app-server client instead of spawning and disposing a new process on every quota refresh.

## Changes

- `readCodexUsageSnapshotInBackground()` now caches the background Codex app-server client by Codex binary path and probe cwd.
- The cached client is disposed after five minutes of inactivity, and is invalidated immediately when the Codex binary path setting changes.
- Known Codex quota endpoint failures such as `failed to fetch codex rate limits ... /backend-api/wham/usage` are shown as `unavailable` instead of a generic error snapshot.
- README documents that the Codex quota probe reuses a short-lived background app-server across refreshes.
- Added regression coverage for cached background quota reads and quota-endpoint unavailable mapping.

## Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts src/main/ipc/__tests__/provider-usage.test.ts src/main/adapters/__tests__/provider-usage.test.ts src/renderer/components/__tests__/DataPanel.test.tsx`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
