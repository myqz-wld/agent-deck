# CHANGELOG_338: Data tab reasoning token column

## Summary

The Data tab now exposes reasoning token totals separately and explains the Claude Code vs Codex accounting model.

## Changes

- Added `token_usage.reasoning_tokens` in migration v035. Existing rows default to `0` because pre-v035 Codex output totals cannot be split retroactively.
- Codex app-server `thread/tokenUsage/updated` now persists `reasoningOutputTokens` as a separate field while preserving the existing total-output behavior used by token/s rankings.
- The Data tab adds a compact Token accounting note, a reasoning total in today's summary, and a reasoning column in the model-by-day table.
- README token-statistics documentation now mentions the reasoning column and accounting note.

## Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/app-server/translate.test.ts src/main/store/__tests__/token-usage-repo.test.ts src/main/store/__tests__/v035-migration.test.ts src/renderer/components/__tests__/DataPanel.test.tsx src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx`
- `pnpm test src/main/store/__tests__/token-usage-repo.test.ts src/main/store/__tests__/v035-migration.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
