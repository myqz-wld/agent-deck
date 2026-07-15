---
changelog_id: 371
changed_at: 2026-07-15
---

# CHANGELOG_371_deepseek-summary-haiku-default: Use Haiku for Deepseek summaries

## Summary

Intermittent summaries now use Deepseek's Haiku alias when the summary model setting is empty. This
keeps the low-cost summary default aligned across Claude and Deepseek without changing Continuation
Context generation, which still uses Sonnet.

## Changes

- Changed the Deepseek summary fallback from `ANTHROPIC_DEFAULT_SONNET_MODEL` / `sonnet` to
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `haiku`.
- Updated the Settings hint and README so the displayed empty-model behavior matches the runtime.
- Stopped materializing a blank legacy Deepseek summary model as an explicit `haiku` value because
  blank now has the same behavior; already explicit user values remain untouched.
- Updated runtime, renderer, and settings-store regression coverage.

## Validation

- `pnpm typecheck` passed.
- Focused summary/default suite: 4 files / 54 tests passed.
- Full suite: 310 files / 2,844 tests passed; one credentialed live smoke remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- A main-process restart was intentionally deferred because the running Agent Deck instance owns this
  implementation session.

## Do Not Split Protection

None. Every changed production TypeScript / TSX file remains below 500 lines.
