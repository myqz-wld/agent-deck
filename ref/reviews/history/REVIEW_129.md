# REVIEW_129

## Trigger Context

User report: "实时输出速率有时候会同时出现Opus和opus-4.8" in the real-time output-rate display. Follow-up user preference: normalized model labels should use bucket-key style such as `opus-4.8` and `gpt-5.5`, matching the rest of the Data tab.

## Method

Targeted code trace across the token-rate path:

- Renderer display: `HeaderTokenRates`, `DataPanel`, `renderer/lib/live-rate`.
- Model normalization: `src/shared/model-normalize.ts`.
- Claude live estimate and result calibration: `src/main/adapters/claude-code/sdk-bridge/live-token-rate.ts` and `sdk-message-translate.ts`.
- Existing token-rate changelogs: `CHANGELOG_197`, `CHANGELOG_206`, `CHANGELOG_212`.

No heterogeneous reviewer session was used because this was a narrow bug fix with a direct repro path and regression tests.

## Findings

### MEDIUM: Live and precise token-rate paths used different model identities

Status: fixed.

Evidence:

- `live-token-rate.ts` resolved live buckets from `sessions.model`, which can be the alias `opus`.
- `sdk-message-translate.ts` result correction and DB token usage use actual SDK model keys such as `claude-opus-4-8`.
- `rankLiveAwareBuckets` intentionally renders `fresh-live ∪ poll`; with buckets `opus` and `opus-4.8`, the UI had to show both.

Fix:

- Read `message_start.message.model` for live ticks when available.
- Pass a single authoritative `result.modelUsage` model key into turn-end live-rate calibration.

### LOW: Claude model labels were inconsistent with gpt bucket labels

Status: fixed.

Evidence:

- Renderer calls `normalizeModel(bucketKey).displayName`.
- Claude labels used title-style names such as `Opus 4.8` while gpt labels used bucket-key style such as `gpt-5.5`.

Fix:

- `normalizeModel` now recognizes Claude bucket-key inputs like `opus-4.8` and `sonnet-4.5`, and recognized model display names now use bucket-key style.

## Validation

- `pnpm exec vitest run src/shared/__tests__/model-normalize.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/live-token-rate.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts` passed: 42 tests.
- `pnpm typecheck` passed.

## Related Changelog

CHANGELOG_302.
