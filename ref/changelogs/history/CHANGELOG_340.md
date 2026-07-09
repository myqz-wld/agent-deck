# CHANGELOG_340: Clarify token accounting and Claude thinking details

## Summary

Moved the Data tab token accounting note under the daily per-model table, rewrote it to explain the column inclusion rules for Claude Code and Codex, and added defensive capture for Claude thinking-token details when the SDK provides them.

## Changes

- Kept the `Token 口径` title but moved the note closer to `每模型每天明细`.
- Clarified that Claude Code input totals should be read as input + cache read + cache write, and that Claude reasoning is displayed only when `usage.output_tokens_details.thinking_tokens` is present.
- Captures Claude assistant `usage.output_tokens_details.thinking_tokens` into `reasoningTokens` while keeping it included in `outputTokens`.
- Keeps `SDKThinkingTokensMessage` live estimates out of daily token statistics because the SDK marks them as non-authoritative display progress.
- Clarified that Codex cached input is already an input-side breakdown and that Codex reasoning is already included in the displayed output total.
- Updated the renderer test and README capability description for the new placement and wording.

## Validation

- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts src/renderer/components/__tests__/DataPanel.test.tsx`
- `pnpm typecheck`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
