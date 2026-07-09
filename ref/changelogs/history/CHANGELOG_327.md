# CHANGELOG_327: `spawn_session` Accepts Custom Model IDs

## Summary

`spawn_session.model` now accepts any non-empty model string and passes it to the target SDK / provider, so new provider models do not require Agent Deck schema updates before callers can use them.

## Behavior

- The MCP schema changed `model` from a hard enum to a trimmed string.
- The maintained alias list remains in the tool description for caller guidance: `haiku`, `sonnet`, `opus`, `fable`, `gpt-5.5`, `gpt-5.4`, `v4-flash`, and `v4-pro`.
- Deepseek aliases still map before session creation:
  - `v4-flash` -> `deepseek-v4-flash`
  - `v4-pro` -> `deepseek-v4-pro[1m]`
- Unknown/custom model names are passed through unchanged for the target SDK / provider to validate.
- `thinking` remains adapter-scoped and strictly validated because Agent Deck maps it into adapter-specific structured options.

## Documentation

README MCP documentation now states that `spawn_session.model` accepts maintained aliases or custom provider model ids.

## Validation

- `pnpm vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts` passed.
- `pnpm typecheck` passed.
