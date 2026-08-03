---
review_id: 171
reviewed_at: 2026-07-24
baseline_commit: 16fb52ec36c7a77e355ffd6fe6821df669787d19
expired: false
---

# REVIEW_171_grok-token-usage-data-panel: Grok usage and live-rate audit

## Scope and method

Reviewed the Grok ACP extension notification path, per-turn usage translation, standard-response
fallback, native history backfill, token usage IPC/preload boundary, live-rate event flow, and Data
tab rendering. Compared the implementation with the existing token usage repository and Claude/
Codex live-rate behavior, and inspected representative local Grok `updates.jsonl` records.

```review-scope
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/extension.ts
src/main/adapters/grok-build/history-usage.ts
src/main/adapters/grok-build/live-token-rate.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/translation-types.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/grok-build/usage-translate.ts
src/main/adapters/grok-build/__tests__/acp-process.test.ts
src/main/adapters/grok-build/__tests__/history-usage.test.ts
src/main/adapters/grok-build/__tests__/live-token-rate.test.ts
src/main/adapters/grok-build/__tests__/translate.test.ts
src/main/ipc/token-usage.ts
src/preload/api/misc.ts
src/renderer/components/DataPanel.tsx
src/renderer/components/__tests__/DataPanel.test.tsx
src/renderer/hooks/use-token-rates-poll.ts
src/shared/types/token-usage.ts
```

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Grok usage is carried by `_x.ai/session/update`, not the standard ACP update callback. | Register a dedicated notification and translate `turn_completed.usage` directly. |
| HIGH | Reusing cumulative standard usage deltas for per-turn extension usage would undercount later turns. | Keep a separate direct translator keyed by `prompt_id`. |
| HIGH | Standard response usage could race an extension notification and create two rows. | Add a short fallback grace window and per-turn source state; late extension data wins within the window. |
| MEDIUM | Scanning all native history from startup would add avoidable startup work. | Require an explicit Data-tab query option for one-time lazy backfill. |
| MEDIUM | Live token/s must not pollute authoritative token totals. | Emit display-only `token-rate-tick` events and calibrate/clear them at turn end. |

## Evidence and validation

- Local Grok history contains `_x.ai/session/update` `turn_completed` records with
  `inputTokens`, `outputTokens`, `cachedReadTokens`, `reasoningTokens`, and `modelUsage`.
- `pnpm typecheck` passed.
- Grok and Data-tab targeted tests passed 17 files / 60 tests.
- `pnpm test` passed 357 files / 3,039 tests, with the repository's one skipped file and one
  skipped test unchanged.
- `pnpm build` passed.
- `git diff --check` passed.

## Residual risk and boundaries

- Grok's extension is vendor-specific and remains separate from standard ACP types.
- Live token/s is display-only text estimation until turn completion; authoritative historical
  totals use provider usage fields only.
- If a provider sends the extension substantially later than the fallback grace window, the
  standard response is retained and the late extension is ignored to avoid double counting.
- History backfill is intentionally one-time per main-process lifetime and only runs when the Data
  tab requests it; a future maintenance command can provide explicit re-scan control.

## Follow-ups

No unresolved in-scope finding remains.
