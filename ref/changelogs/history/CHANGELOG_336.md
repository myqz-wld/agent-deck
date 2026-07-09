# CHANGELOG_336: Refresh Claude and Codex runtime packages

## Summary

Updated the bundled Claude and Codex runtime dependencies to the latest stable npm versions available on 2026-07-01.

## Changes

- `@anthropic-ai/claude-agent-sdk`: `^0.3.195` -> `^0.3.197`.
- `@anthropic-ai/sdk`: `^0.106.0` -> `^0.109.0`.
- `@openai/codex`: `^0.142.3` -> `^0.142.4`.
- Refreshed `pnpm-lock.yaml`, including Claude Agent SDK native platform packages and Codex native platform packages.
- Confirmed `@modelcontextprotocol/sdk` remains current at `1.29.0`.

## Validation

- `pnpm outdated @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @openai/codex @modelcontextprotocol/sdk`
- `pnpm view @modelcontextprotocol/sdk version`
- `node -p "require('./node_modules/@openai/codex/package.json').version"`
- `node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"`
- `node -p "require('./node_modules/@anthropic-ai/sdk/package.json').version"`
- `./node_modules/.bin/codex --version`
- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/codex-binary-layout.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/query-options-builder.test.ts`
- `pnpm typecheck`
- `pnpm build`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
