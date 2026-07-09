# CHANGELOG_342: Rewrite Deepseek token model aliases

## Summary

Deepseek token statistics now rewrite Claude-family internal model aliases to the configured Deepseek model ids before aggregation.

## Changes

- Added a Deepseek config helper that resolves Claude alias families (`fable`, `opus`, `sonnet`, `haiku`) to the current Deepseek default model settings without requiring an API token.
- Updated the Deepseek adapter event rewrite layer so `token-usage` payloads such as `claude-haiku-4-5` are stored under the configured Deepseek model id, for example `deepseek-v4-flash`.
- Left native Deepseek model ids unchanged.
- Updated tests and README documentation for the corrected token statistics behavior.

## Validation

- `pnpm exec vitest run src/main/adapters/deepseek-claude-code/__tests__/config.test.ts src/main/adapters/deepseek-claude-code/__tests__/summarise-events.test.ts`
- `pnpm typecheck`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
