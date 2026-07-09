# CHANGELOG_280

## Agent Deck MCP plan review timeout follows permission timeout

### Summary

Codex sessions now configure the built-in `agent-deck` MCP tool timeout from the app's permission approval timeout setting, and `request_plan_review` uses the same setting for its pending UI card when callers omit `timeoutMs`.

### Changes

- The Codex auto-injected `mcp_servers.agent-deck.tool_timeout_sec` now derives from `settings.permissionTimeoutMs` (`30min` default → `1800`, `0` → no timeout).
- `request_plan_review` now uses `permissionTimeoutMs` as its default semantic timeout; explicit `timeoutMs` can shorten the wait, but cannot extend beyond the permission timeout when that setting is enabled.
- Updated the `request_plan_review` MCP tool descriptions to state the permission-timeout default.
- Added focused coverage for the timeout conversion and handler timeout resolution paths.

### Validation

- `node_modules/.bin/codex mcp get agent-deck -c 'mcp_servers.agent-deck.url="http://127.0.0.1:1/mcp"' -c 'mcp_servers.agent-deck.tool_timeout_sec=0'`
- `node_modules/.bin/codex mcp get agent-deck -c 'mcp_servers.agent-deck.url="http://127.0.0.1:1/mcp"' -c 'mcp_servers.agent-deck.tool_timeout_sec=1800'`
- `pnpm exec vitest run src/main/codex-config/__tests__/agent-deck-mcp-injector.test.ts src/main/agent-deck-mcp/__tests__/request-plan-review.handler.test.ts`
- `pnpm typecheck`

### Notes

- Earlier in this task, `pnpm test:node -- src/main/codex-config/__tests__/agent-deck-mcp-injector.test.ts` did not restrict execution to the target file in this environment. The target test passed, but the broader run reported three pre-existing `spawn-agent-name-routing.test.ts` failures caused by prompt context block expectations unrelated to this change.
