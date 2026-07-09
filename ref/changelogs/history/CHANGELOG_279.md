# CHANGELOG_279

## Standalone `spawn_session` reply anchors and immediate tree refresh

### Summary

Standalone `spawn_session` calls now get the same first-reply anchor path as team spawns. The spawned child receives a wire prefix plus context block that includes the lead session id and `spawnPromptMessageId`; when no `teamName` is provided, the instructions tell the child to omit `teamId` so `send_message` uses teamless DM.

### Changes

- `buildLeadContextBlock` now accepts `teamId=null` and renders a teamless-DM `send_message` example without a `teamId` argument.
- `spawnSessionHandler` injects the wire prefix/context block and creates a delivered placeholder message for all normal caller-owned spawns, not only team spawns.
- Standalone placeholders are stored with `teamId=null`, so the existing teamless reply pair-scope validation can link the first child reply back to the lead.
- `spawnSessionHandler` emits `session-upserted` immediately after a successful `setSpawnLink`, so SessionList can render the child under its parent without waiting for later SDK activity.
- Claude/Codex bundled runtime protocol text and the MCP tool description now say `spawn_session` returns `spawnPromptMessageId` for the first reply chain, while `teamName` only controls shared-team creation.

### Validation

- `pnpm test src/main/agent-deck-mcp/__tests__/lead-context-block.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts`
- `pnpm typecheck`
