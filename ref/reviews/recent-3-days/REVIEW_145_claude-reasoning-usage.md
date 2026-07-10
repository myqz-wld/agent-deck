---
review_id: 145
reviewed_at: 2026-07-10
baseline_commit: b317269394a476543c572971af64f89f07195e31
expired: false
skipped_expired: []
---

# REVIEW_145_claude-reasoning-usage: Claude reasoning usage and option-boundary review

## Scope

This review traced Claude reasoning usage from installed SDK message types through translation, turn correction, persistence, aggregation, and Deepseek rewriting. It also checked whether Codex `max` is a provider-wide invalid value or a model-specific capability before changing the settings selector.

```review-scope
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts
src/main/adapters/claude-code/sdk-bridge/thinking-token-usage.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-thinking-token-usage.test.ts
src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts
src/main/adapters/deepseek-claude-code/__tests__/summarise-events.test.ts
src/main/store/settings-store.ts
src/main/store/__tests__/settings-store-codex-reasoning.test.ts
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/shared/types/settings/app-settings.ts
src/shared/types/token-usage.ts
```

## Method

- Ran two independent read-only audits in parallel: one enumerated Codex option / validation surfaces and current model capability evidence; the other traced Claude SDK usage payloads, installed type definitions, real transcript fixtures, storage, and renderer flow.
- Compared the installed Claude Agent SDK 0.3.205 `SDKThinkingTokensMessage` contract with the fields consumed by the translator.
- Compared the installed Codex 0.144.0 model catalog with the static settings options.
- Rejected the first direct-persistence implementation after the usage audit demonstrated DB / IPC amplification, future double-counting, and incorrect primary-model attribution.
- Reworked the fix around turn-local accumulation and result-bound correction, then ran focused and full repository validation.

## Gate Result

PASS.

Severity distribution:

- CRITICAL: 0
- HIGH: 1 fixed during review
- MEDIUM: 4 fixed
- LOW: 1 fixed, 1 dispositioned
- Residual risk: 2 documented

## Findings and Decisions

### HIGH fixed: direct delta persistence would amplify writes and make estimates irreversible

The initial implementation emitted one token-usage event for every SDK thinking delta. A long reasoning block could therefore produce many synchronous SQLite writes and renderer notifications, while a later authoritative output detail could not subtract already persisted estimates. The audit caught this before final validation.

Fix: keep estimates in turn-local memory, deduplicate SDK UUIDs, and emit only result-bound correction rows. Expected-close and resultless termination paths clear partial state without persisting an incomplete turn.

### MEDIUM fixed: the translator consumed a field absent from current Claude CLI frames

The existing collector read `output_tokens_details.thinking_tokens`, but current assistant and result frames do not populate it. The installed SDK instead exposes approximate `system/thinking_tokens` frames with a running total and an incremental delta.

Fix: accumulate only `estimated_tokens_delta`; never sum the cumulative `estimated_tokens` field. Keep the exact result field as a higher-priority compatibility path if a future runtime provides it.

### MEDIUM fixed: non-empty modelUsage discarded aggregate reasoning details

`emitResultUsageCorrection` returned after processing any non-empty `modelUsage`, whose installed SDK shape has no reasoning member. That early return would also ignore a future aggregate authoritative reasoning detail.

Fix: reconcile reasoning independently of input/output/cache correction, so aggregate details remain visible even with model-level usage.

### MEDIUM fixed: primary-model attribution was wrong for fallback or subagent output

Thinking-token frames do not include a model. Assigning them to the persisted primary model would mislabel output when the stream's `message_start` reports a different model.

Fix: capture the active normalized stream bucket, re-home a single ambiguous estimate to a single result model, preserve independent multi-model buckets, and retain Deepseek alias rewriting.

### MEDIUM fixed: aggregate allocation reused reasoning already persisted for a model

The first result-bound allocator subtracted persisted reasoning from the global remainder but still weighted each model by its full estimate. Aggregate totals stayed correct, while per-model totals could drift toward a bucket whose estimate had already been fully recorded.

Fix: derive weights from each model's unpersisted estimate remainder, allocate those evidence-backed remainders first, and use remaining inclusive output capacity only as the fallback.

### LOW fixed: unmatched multi-model estimates could exceed aggregate output

When `modelUsage` was empty or omitted estimated models, the first fallback clamped only a single estimate against aggregate output. Multiple unmatched buckets could therefore sum above the result's inclusive output total.

Fix: apply one aggregate correction budget after subtracting all persisted reasoning, then allocate that budget proportionally across the remaining per-model estimates.

### LOW dispositioned: Codex MAX is not globally invalid

The current Codex model catalog reports `max` for GPT-5.6 sol / terra / luna, while GPT-5.5 and GPT-5.4 stop at `xhigh`. Removing `max` from shared validation would hide valid 5.6 behavior and incorrectly alter MCP/custom-agent passthrough.

Decision: remove `MAX` only from the generic summary / Hand-off settings selector and migrate older selector values to `xhigh`. Leave model-specific backend capabilities intact.

## Validation / Evidence

- Focused Claude accounting, lifecycle cleanup, Deepseek rewrite, settings migration, and renderer selector suite: 6 files and 47 tests passed.
- Full suite: 204 files and 2227 tests passed, including real Electron-ABI SQLite usage tests.
- `pnpm typecheck`
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`
- Installed SDK types confirmed `SDKThinkingTokensMessage` is approximate and `ModelUsage` has no reasoning field.
- Installed Codex 0.144.0 model metadata confirmed model-specific `max` / `ultra` support.

## Fixes Landed

- Added turn-local estimate state, per-frame UUID deduplication, actual stream-model attribution, result-time correction, inclusive-output clamps, multi-model allocation, and lifecycle cleanup.
- Added 14 focused Claude thinking-token tests plus resultless cleanup and Deepseek rewrite coverage.
- Hid Codex `MAX` from the two settings rows, migrated retained Codex values to `xhigh`, and preserved Claude / Deepseek `max`.

## Residual Risk

- Claude's available signal is an SDK estimate and may differ from billed output. Turns where the SDK emits no thinking-token estimate and no authoritative detail will continue to show zero reasoning rather than an invented value.
- `sdk-message-translate.ts` remains a pre-existing over-500-line translator. New accounting logic was extracted to `thinking-token-usage.ts`; revisit the translator boundary at 720 lines or the next independent translation feature.

## Follow-ups

- Restart the hosting Agent Deck application before interactive verification. It was not restarted because the installed instance owns this session and port 47821.

## Related Records

- [CHANGELOG_354](../../changelogs/recent-3-days/CHANGELOG_354_thinking-options-and-claude-usage.md)
