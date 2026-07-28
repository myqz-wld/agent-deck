---
changelog_id: 389
changed_at: 2026-07-24
---

# CHANGELOG_389_grok-token-usage-data-panel: Collect Grok turn usage

## Summary

Capture Grok's `_x.ai/session/update` `turn_completed` usage events, backfill matching native
session history on demand, and expose both historical token totals and live token/s estimates in
the Data tab without fabricating usage when the provider omits it.

## Changes

### Extension usage and deduplication

- Register `_x.ai/session/update` as a separate ACP notification in the Grok process wrapper.
- Translate per-turn `inputTokens`, `outputTokens`, `reasoningTokens`, and `cachedReadTokens`
  directly; use `prompt_id` as the token usage message id and keep cache creation at zero.
- Deduplicate repeated extension events by `prompt_id`.
- Delay standard `session.prompt` usage fallback briefly so an extension notification arriving
  after the response cannot create a second row; retain standard cumulative-delta fallback when
  no extension usage arrives.

### History and Data tab

- Scan `~/.grok/sessions/**/updates.jsonl` only when the Data tab opts into history, map native
  session ids back to Agent Deck Grok records, and reuse the token usage unique index for
  idempotent imports.
- Keep startup preload and Header rate polling on the existing database rows so history scanning
  does not block application startup.
- Feed display-only live token rate ticks from Grok text chunks, calibrate at turn completion,
  clear on cancellation/close, and prefer fresh live values over the persisted 60-second window.
- Document Grok's token accounting separately in the Data tab; no character-count estimate is
  written to `token_usage`.

## Validation

- `pnpm typecheck` passed.
- `pnpm vitest run src/main/adapters/grok-build src/renderer/components/__tests__/DataPanel.test.tsx src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx` passed 17 files and 60 tests.
- `pnpm test` passed 357 files and 3,039 tests; one file and one test remain intentionally skipped.
- `pnpm build` passed.
- `git diff --check` passed.

## Do Not Split Protection

- No production source file changed by this delivery exceeds 500 lines. Grok ACP startup remains
  isolated in `runtime-start.ts`; revisit only if runtime startup and event translation develop a
  stronger shared abstraction.

## Related records

- `CHANGELOG_388_grok-mid-turn-interjection.md`
- `REVIEW_171_grok-token-usage-data-panel.md`
