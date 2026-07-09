# CHANGELOG_346: Refresh Claude/Codex dependencies and verify GPT-5.6

## Summary

Updated bundled Claude/Codex runtime dependencies to the latest npm versions available on 2026-07-09 and verified the current Codex ChatGPT account can run the new GPT-5.6 Sol model slug.

## Changes

- `@anthropic-ai/claude-agent-sdk`: `^0.3.204` -> `^0.3.205`, including the matching native optional packages.
- `@openai/codex`: `^0.143.0` -> `^0.144.0`, including the matching platform optional packages.
- Confirmed `@anthropic-ai/sdk` remains current at `0.110.0`.
- Confirmed the online Codex model catalog now includes:
  - `gpt-5.6-sol`
  - `gpt-5.6-terra`
  - `gpt-5.6-luna`
- Confirmed the bare `gpt-5.6` alias is still unsupported for this ChatGPT-backed Codex account.
- Verified `gpt-5.6-sol` succeeds and is the exact user-level default slug currently present in `~/.codex/config.toml`.

## Validation

- `npm view @openai/codex version` -> `0.144.0`
- `npm view @anthropic-ai/claude-agent-sdk version` -> `0.3.205`
- `npm view @anthropic-ai/sdk version` -> `0.110.0`
- `pnpm up @openai/codex@latest @anthropic-ai/claude-agent-sdk@latest @anthropic-ai/sdk@latest`
- `pnpm outdated @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @openai/codex` returned no outdated rows.
- `node -p "require('./node_modules/@openai/codex/package.json').version"` -> `0.144.0`
- `node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"` -> `0.3.205`
- `node -p "require('./node_modules/@anthropic-ai/sdk/package.json').version"` -> `0.110.0`
- `node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(typeof m.query))"` -> `function`
- `./node_modules/.bin/codex --version` -> `codex-cli 0.144.0`
- `codex debug models` showed `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- `codex exec --model gpt-5.6` returned the expected unsupported-model error.
- `codex exec --model gpt-5.6-sol` returned `OK`.
- `pnpm typecheck` passed.
- `git diff --check` passed.

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
