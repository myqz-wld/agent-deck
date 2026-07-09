# CHANGELOG_339: Refresh Claude and Codex dependencies

## Summary

Updated the direct Claude and Codex runtime dependencies to the latest stable npm versions available during this maintenance pass.

## Changes

- `@anthropic-ai/claude-agent-sdk`: `^0.3.197` -> `^0.3.199`.
- `@anthropic-ai/sdk`: `^0.109.0` -> `^0.110.0`.
- `@openai/codex`: `^0.142.4` -> `^0.142.5`.
- Refreshed `pnpm-lock.yaml`, including the related native runtime packages.
- Adjusted one Claude `canUseTool` unit test to narrow the newer SDK callback return type before reading deny-only fields.

## Validation

- `npm view @anthropic-ai/claude-agent-sdk version`
- `npm view @anthropic-ai/sdk version`
- `npm view @openai/codex version`
- `pnpm outdated @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @openai/codex`
- `node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"`
- `node -p "require('./node_modules/@anthropic-ai/sdk/package.json').version"`
- `node -p "require('./node_modules/@openai/codex/package.json').version"`
- `./node_modules/.bin/codex --version`
- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/can-use-tool.test.ts src/main/adapters/codex-cli/__tests__/codex-binary-layout.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/query-options-builder.test.ts src/main/adapters/__tests__/provider-usage.test.ts`
- `pnpm typecheck`
- `pnpm build`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
