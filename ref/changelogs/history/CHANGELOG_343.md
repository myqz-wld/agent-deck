# CHANGELOG_343: Refresh Claude Agent SDK runtime dependency

## Summary

Updated the direct Claude Agent SDK runtime dependency to the latest stable npm version available on 2026-07-05. The Codex and Anthropic SDK packages were checked and were already current.

## Changes

- `@anthropic-ai/claude-agent-sdk`: `^0.3.199` -> `^0.3.201`.
- Refreshed `pnpm-lock.yaml`, including the related Claude Agent SDK native platform packages.
- Confirmed `@anthropic-ai/sdk` remains current at `0.110.0`.
- Confirmed `@openai/codex` remains current at `0.142.5`.
- Confirmed `@modelcontextprotocol/sdk` remains current at `1.29.0`.

## Validation

- `pnpm outdated @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @openai/codex`
- `npm view @anthropic-ai/claude-agent-sdk version`
- `npm view @anthropic-ai/sdk version`
- `npm view @openai/codex version`
- `npm view @modelcontextprotocol/sdk version`
- `node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"`
- `node -p "require('./node_modules/@anthropic-ai/sdk/package.json').version"`
- `node -p "require('./node_modules/@openai/codex/package.json').version"`
- `./node_modules/.bin/codex --version`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
