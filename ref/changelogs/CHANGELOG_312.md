# CHANGELOG_312: Set provider quota refresh cadence to 10 minutes

## Summary

Provider quota snapshots now refresh every 10 minutes instead of every 5 minutes. The main-process cache TTL remains slightly shorter than the renderer interval, and the Codex background quota app-server client idle lifetime tracks the same cadence so it can still be reused across scheduled refreshes.

The deep-review also fixed a Codex MCP spawn regression from the fast temp-session path: `spawn_session` now asks Codex creates to return the canonical post-`thread.started` id, so follow-up MCP calls can address the spawned teammate without a manual `list_sessions` recovery. Codex app-server translation now drops empty assistant-visible message items before they reach the activity feed.

## Changes

- `PROVIDER_USAGE_REFETCH_MS` is now `10 * 60_000`.
- Main-process provider usage cache TTL is now `10 minutes - 5 seconds`.
- Codex background quota app-server idle disposal now follows `PROVIDER_USAGE_REFETCH_MS` instead of a separate 5-minute constant.
- Codex create-session options now support `awaitCanonicalId` for programmatic callers that need a durable handle.
- MCP `spawn_session` passes `awaitCanonicalId` for `codex-cli`; interactive UI creation keeps the immediate temp-session path.
- Empty Codex `agentMessage` and `plan` completion items are filtered out instead of rendering as `（空消息）`.
- Regression tests cover both Codex bridge temp-to-real return behavior and `spawn_session` → `send_message` using the returned Codex id.
- Regression tests cover empty assistant-visible Codex app-server item filtering.
- README provider quota refresh documentation now states 10 minutes.
- Regression tests now assert the 10-minute renderer interval and main TTL.

## Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/app-server/translate.test.ts src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts src/main/ipc/__tests__/provider-usage.test.ts src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts`
- `pnpm exec vitest run src/main/ipc/__tests__/provider-usage.test.ts src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts`
- `pnpm typecheck`
