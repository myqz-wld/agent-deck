---
changelog_id: 587
changed_at: 2026-08-10
---

# CHANGELOG_587_remote-token-usage-ingest: Persist Remote token telemetry

## Summary

Headless Server Cores now persist provider `token-usage` events through the same token ledger used
by Local sessions. Remote Data and header tok/s views can therefore report real rolling and daily
usage instead of remaining empty after successful Relay sessions.

## Changes

- Route Server Core token telemetry through the shared `AgentEvent`-to-`token_usage` projection and
  keep it out of ordinary session history.
- Publish a bounded Core revision after successful telemetry persistence so Remote readers can
  observe the data change without exposing the usage payload.
- Recover provider-keyed telemetry that pre-fix Server Cores wrote into `events`; replay is
  idempotent through the existing message-id upsert and does not delete legacy rows.
- Skip legacy rows without a stable provider message id and isolate recovery or persistence failure
  from provider execution.
- Add regression coverage for dedicated telemetry routing, payload projection, failure isolation,
  and repeat-safe legacy recovery.

## Validation

- Focused telemetry and Server Core suites: 6 files / 61 tests passed.
- `pnpm test` — 878 files / 5,713 tests passed; 2 files / 3 tests skipped.
- `pnpm typecheck` passed architecture and Node/Web TypeScript checks.
- `pnpm build`
- `pnpm build:linux-headless` and `pnpm check:linux-headless`
- `pnpm check:deployment`
- `pnpm verify:macos-worker-sandbox`
- Production pre-fix evidence showed 9 `token-usage` events, 0 `token_usage` rows, and empty Remote
  `rates`, `topToday`, and `daily` after two successful model sessions.
- Package, deployment, and post-deployment acceptance results are recorded in
  `REVIEW_228_remote-token-usage-ingest.md`.

## Compatibility and recovery

No wire schema changes. Existing protocol 2.1 clients keep using `usage.tokens.get`. The startup
recovery is repeat-safe for keyed rows and leaves legacy event history intact; ambiguous unkeyed
rows are reported and skipped instead of being duplicated.
