# CHANGELOG_302

## Token Rate Model Bucket Alignment

### Summary

Fixed a Data tab / header token-rate display bug where a Claude session could show both `opus` and `opus-4.8` during the same turn.

### Root Cause

The live token-rate path used `sessions.model`, which can be the configured alias `opus`, while the precise turn-end token usage path used the SDK-returned model key such as `claude-opus-4-8`. The renderer ranked the union of live and polled buckets, so those two sources appeared as separate models. The renderer also re-normalized the already-normalized bucket key `opus-4.8`, which fell through to inconsistent fallback display behavior.

### Changes

- `normalizeModel` now recognizes already-normalized Claude bucket keys such as `opus-4.8` and displays recognized model labels in bucket-key style, matching `gpt-5.5`.
- Claude live token-rate tracking now reads the actual model from `message_start.message.model` when present.
- Turn-end live-rate calibration now uses the single authoritative `result.modelUsage` model key when the result identifies one output model, so alias live buckets are replaced by the precise bucket before renderer ranking.
- Added regression tests for model bucket display, live tick alias override, and result calibration alias override.

### Validation

- `pnpm exec vitest run src/shared/__tests__/model-normalize.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/live-token-rate.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts`
- `pnpm typecheck`
