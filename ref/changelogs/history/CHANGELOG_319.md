# CHANGELOG_319: Claude and Codex dependency version bump

## Summary

Updated the bundled Claude and Codex runtime dependencies to the latest stable npm
registry versions available during this maintenance pass.

## Changes

- `@anthropic-ai/claude-agent-sdk`: `^0.3.181` -> `^0.3.186`.
- `@anthropic-ai/sdk`: `^0.104.2` -> `^0.105.0`.
- `@openai/codex`: `^0.141.0` -> `^0.142.0`.
- Synchronized `pnpm-lock.yaml`, including the Claude Agent SDK platform packages and
  Codex platform native packages.
- Verified the installed Codex `0.142.0` platform package still uses the supported
  new vendor layout: `vendor/<triple>/bin/codex`, `codex-package.json`, and
  `codex-path/rg`.

## Validation

- `pnpm outdated @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @openai/codex`
- `npm view @anthropic-ai/claude-agent-sdk version dist-tags versions --json`
- `npm view @anthropic-ai/sdk version dist-tags versions --json`
- `npm view @openai/codex version dist-tags versions --json`
- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/codex-binary-layout.test.ts src/main/adapters/codex-cli/app-server/client.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/query-options-builder.test.ts src/main/adapters/__tests__/provider-usage.test.ts`
- `pnpm typecheck`
- `pnpm build`
