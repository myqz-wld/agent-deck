# CHANGELOG_310: Reduce directory picker and Codex create-session waits

## Summary

New-session UX now avoids two visible stalls: directory selection is single-flight with explicit pending feedback, and Codex new-session creation returns a temporary session immediately while the app-server thread id is resolved in the background. Provider quota refresh remains at the user-confirmed 5-minute cadence.

## Changes

- Directory browsing in `NewSessionDialog` now disables the browse button while the native picker is open, shows `选择中...`, ignores repeated clicks, and avoids setting dialog state after close.
- Main-process directory selection now shares one in-flight native picker promise so duplicate renderer calls cannot stack multiple dialogs.
- Provider usage refresh constants are centralized and tested: renderer refresh stays `5 * 60_000`, main-process cache TTL stays `5 minutes - 5 seconds`.
- Codex new-session creation now emits and returns a temp session before waiting for app-server `thread.started`; the existing `sessionManager.renameSdkSession(temp, real)` path migrates DB/UI state when the real id arrives.
- Codex background thread startup is deferred to the next macrotask so synchronous post-create writes such as spawn links, team membership, and reply anchors can register against the temp session before any real-id rename.
- Codex background startup fallback now appends error/finished to the already-visible temp session without duplicating the session-start or first user message.
- Codex `thread.started` timeout fallback now distinguishes its own abort from a user close, so the timeout still emits error/finished and cleans temp tokens.
- Closing a temp Codex session before `thread.started` now prevents a late real id from renaming or reviving the closed session.

## Validation

- `pnpm exec vitest run src/renderer/components/__tests__/NewSessionDialog.test.tsx src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx src/renderer/components/__tests__/DataPanel.test.tsx src/main/ipc/__tests__/provider-usage.test.ts src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
