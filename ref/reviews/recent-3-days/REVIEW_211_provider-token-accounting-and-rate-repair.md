---
review_id: 211
reviewed_at: 2026-08-03
baseline_commit: 70916679f710446fe8ef6c77af060d86ce6545c1
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record and bucket-index maintenance are mechanical archive work."
---

# REVIEW_211_provider-token-accounting-and-rate-repair: Provider token totals and tok/s

## Scope and method

The audit compared stored token rows with native Claude/Codex/Grok provider records, traced every
adapter's translation and live-rate path, reproduced sequential cumulative snapshots, and then
implemented focused repairs. This was an implementation and self-review pass; neither
`simple-review` nor `deep-review` was invoked.

```review-scope
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-thinking-token-usage.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/final-result-usage.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/codex-cli/app-server/token-usage-observation.ts
src/main/adapters/codex-cli/app-server/token-usage-translate.ts
src/main/adapters/codex-cli/app-server/translate.test.ts
src/main/adapters/codex-cli/app-server/translate.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/live-token-rate.test.ts
src/main/adapters/codex-cli/sdk-bridge/live-token-rate.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/adapters/codex-cli/sdk-bridge/types.ts
src/main/adapters/grok-build/__tests__/live-token-rate.test.ts
src/main/adapters/grok-build/live-token-rate.ts
src/main/adapters/grok-build/provider-completion-recovery.ts
src/main/adapters/grok-build/turn-response.ts
src/main/index/bootstrap-infra.ts
src/main/store/__tests__/token-usage-legacy-repair.test.ts
src/main/store/token-usage-legacy-repair.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Claude `result.modelUsage` is native-session cumulative, but every result row was stored as a new additive observation. The inspected rows were about 2.1x inflated earlier in the audit and continued growing with each active turn. | Restore per-call assistant persistence, retain a native-thread result watermark, emit only the missing positive remainder, baseline native resume, and convert exactly identifiable legacy result rows to deltas at startup. |
| MEDIUM | Claude final tok/s divided cumulative output by only the current decode window, inflating later-turn calibration by the same cumulative factor. | Feed live calibration the reconciled current-turn output and current model attribution. |
| MEDIUM | Codex trusted every positive `last` row even when cumulative `total` was unchanged. This persisted repeated snapshots and context-compaction occupancy as provider usage and could emit false tok/s ticks. | Make cumulative growth the additive fact, fingerprint totals for cross-restart idempotence, share the observation with persistence/live rate, and delete only mathematically impossible legacy context-only rows. |
| MEDIUM | Grok preferred the visible text-callback span over `apiDurationMs`; observed positive spans covered a median 22.8% of provider API time, while 19 of 28 native records had zero span at persisted timestamp precision. The first estimated chunk also preceded its timing anchor. | Prefer provider duration for final calibration, propagate it through all exact completion paths, and start interim estimation after the first callback. |

No confirmed finding remains open.

## Validation and evidence

- Claude native JSONL assistant-message IDs deduplicated to the latest cumulative result totals for
  the inspected sessions, confirming assistant usage as the per-call additive source.
- Codex native logs contained unchanged cumulative totals paired with repeated positive `last`
  snapshots and context-only rows. Deterministic sequence tests now cover both cases and stable IDs.
- The current database read-only projection found 17 identifiable Claude cumulative rows: input
  changed from 2,986,705 additive-as-stored to 581,851 after differencing; output from 1,431,196 to
  324,629; cache-read from 254,155,136 to 61,971,456. It also found 46 exact Codex context-only
  rows carrying 1,186,031 bogus provider-total tokens.
- The Electron-ABI full suite passed 449 files and 3,685 tests; one credentialed live smoke remained
  intentionally skipped. Node/renderer typechecks and the production build passed.
- All changed production files are at or below the 500-line guardrail.

## Fixes landed

- Claude accounting now separates per-call durable usage from cumulative final reconciliation and
  uses the same current-turn result for tok/s.
- Codex persistence and live tok/s share a thread-lifetime cumulative observation with stable IDs.
- Grok final rate uses provider elapsed time whenever the provider supplies it.
- Startup repair is transactional, idempotent, schema-neutral, and restricted to provably bad row
  shapes; daily-rollup triggers mark affected days dirty automatically.

## Residual risk

- Legacy Codex positive replay rows cannot be distinguished from genuine deltas using database rows
  alone because the old implementation stored neither cumulative totals nor stable IDs. They are
  intentionally retained; deleting them would be speculative. New snapshots are idempotent.
- A first Codex snapshot after upgrading can still match one old anonymous row but cannot match it by
  identity; after the first v2 fingerprint is stored, cross-restart replay is deduplicated.
- No live provider turn was run. Grok had no database rows, and persisted callback timestamps have
  one-second precision, so deterministic tests provide the exact rate-boundary coverage.

## Follow-up

After the next normal restart, confirm the startup repair log counts, compare the Data panel totals
with the projected deltas above, then run one two-turn session per adapter and verify that the second
turn adds only its own usage and produces a plausible final tok/s tick.
