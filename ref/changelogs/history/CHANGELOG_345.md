# CHANGELOG_345: Refresh Claude and Codex runtime dependencies

## Summary

Updated Claude/Codex runtime packages to the latest npm versions available on 2026-07-08. The Anthropic TypeScript SDK was checked and remains current.

## Changes

- `@anthropic-ai/claude-agent-sdk`: `^0.3.201` -> `^0.3.204`, including the matching native optional packages.
- `@openai/codex`: `^0.142.5` -> `^0.143.0`, including the matching platform optional packages.
- Confirmed `@anthropic-ai/sdk` remains current at `0.110.0`.

## Validation

- `npm view @anthropic-ai/claude-agent-sdk version`
- `npm view @anthropic-ai/sdk version`
- `npm view @openai/codex version`
- `pnpm up @anthropic-ai/claude-agent-sdk@latest @anthropic-ai/sdk@latest @openai/codex@latest`
- `pnpm outdated @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @openai/codex`
- `node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"`
- `node -p "require('./node_modules/@anthropic-ai/sdk/package.json').version"`
- `node -p "require('./node_modules/@openai/codex/package.json').version"`
- `node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(typeof m.query))"`
- `./node_modules/.bin/codex --version`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
