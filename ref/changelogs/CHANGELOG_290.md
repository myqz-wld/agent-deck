# CHANGELOG_290 - Codex sandbox next-turn apply

## Summary

- Codex sandbox switching no longer closes and recreates the app-server thread. The compatibility method `restartWithCodexSandbox` now persists `sessions.codex_sandbox`, emits `session-upserted`, and patches live thread options so the next `turn/start` uses the new sandbox.
- A running Codex turn keeps the sandbox it already started with, and queued pending messages are preserved for the next turn instead of being dropped by `closeSession`.
- Closing Codex sandbox (`danger-full-access`) still shows the destructive confirmation dialog, but the dialog now says the change applies from the next Codex turn and no longer promises a restart.
- Claude permission mode behavior from CHANGELOG_289 remains unchanged: non-bypass permission changes can persist when the DB session exists but no live SDK query is running. Claude OS sandbox and `bypassPermissions` still use cold restart because those SDK options are query-spawn settings.

## Validation

- `pnpm test:node src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts src/main/adapters/codex-cli/app-server/client.test.ts`
- `pnpm test:node src/main/adapters/claude-code/sdk-bridge/__tests__/set-permission-mode-rollback.test.ts`
- `pnpm typecheck`
