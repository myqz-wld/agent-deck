---
changelog_id: 365
changed_at: 2026-07-14
---

# CHANGELOG_365_automatic-continuation-checkpoints: Keep continuation checkpoints fresh and bounded

## Summary

Continuation checkpoints now refresh automatically in the background instead of waiting for a
hand-off or missing-history recovery to discover a large stale backlog. Normal refresh is deliberately
low-frequency: it requires the configured 30-minute interval, at least 8,000 new normalized tokens,
60 seconds of quiet, and an idle provider. A 48,000-token safety backlog bypasses those scheduling
gates but still does not interrupt or mutate the active provider turn.

Checkpoint and periodic-summary controls are now separate settings. Both are enabled by default, and
their provider-specific model / Thinking defaults match their different workloads. The settings page
also explains every independent generator, canonical, projection, raw-tail, target-window, and byte
budget rather than presenting them as one interchangeable context limit.

## Automatic checkpoint lifecycle

- Observes durable session revisions, estimates eligible backlog in a read-only SQLite worker, and
  serializes background provider generation globally with one active job.
- Materializes the latest durable revision boundary in a production Node worker, not Electron main,
  with 10,000-row / 32 MiB source guards and at most 1 MiB per chunk response.
- Lets foreground hand-off or recovery cancel and supersede same-session background work without
  waiting for unrelated queued jobs. Rename, delete, restart, dormant sessions, and shutdown retain
  explicit cancellation and drain boundaries.
- Uses revision-head and rebuild-epoch CAS checks before commit. Partial complete-revision prefixes
  are honest coverage and automatically re-arm the remaining backlog.
- Rebuilds normalization from the exact consumed raw prefix, so a tool completion outside the
  committed prefix cannot suppress its earlier in-flight tool evidence.

## Bounded canonical state and budgets

- Fits canonical checkpoints toward 20,000 estimated tokens and refuses to commit above 24,000 when
  required state alone cannot fit. Active, blocked, prior-active resolution, and coverage-gap facts
  are protected.
- Evicts only whole optional facts in deterministic global order: completed/superseded/resolved
  status, then priority, evidence recency, section rank, and stable id. SQLite still retains only the
  latest three validated checkpoint generations per session.
- Keeps the generator input at 96k when capacity is unknown; observed windows reserve 32k and cap
  input at 128k. The combined system/user provider prompt also remains under 512 KiB.
- For continuation delivery, falls back to a 128k target window, reserves 16k for current system /
  project instructions and 8k for the response, charges wrappers and the authoritative instruction,
  allocates 20% of the remainder to checkpoint projection (clamped to 2k-12k), then fills the rest
  with recent user input up to the configurable 64k raw-tail ceiling.

## Defaults and settings

- Automatic checkpoints default to enabled / 30 minutes. Claude and Deepseek use Sonnet / `medium`;
  Codex delegates the blank model to `config.toml` and uses `medium`.
- Periodic summaries now have an enable switch and remain enabled by default. Claude uses Haiku /
  `low`, Deepseek uses Sonnet / `low`, and Codex delegates the model to `config.toml` with `low`.
- Compatibility repair preserves existing valid settings and materializes only the two historical
  blank-model fallbacks whose meaning changed: Claude checkpoint Opus and Deepseek summary Haiku.
- IPC validates model strings and length, persisted malformed values are repaired, and Simplified-
  Chinese settings copy distinguishes checkpoint cadence, summary cadence, semantic eviction, and
  all context budgets.

## Validation

- The continuation, store, lifecycle, settings, and summary suite passed 45 files / 261 tests; one
  credentialed live smoke remained skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed. The emitted
  background-worker closure contains no Electron, logger, migration, or process-DB facade imports.
- The real built worker opened the Electron-ABI database, selected the latest valid checkpoint,
  materialized a 10,000-row prefix while main-loop heartbeats continued, served a chunk, and exited
  cleanly.
- The final full-tree run passed 305 files and 2,793 tests; its sole failure was the concurrently
  edited, out-of-scope `PlanDeepReviewDialog.test.tsx`, which also failed alone and is not part of
  this commit.
- A standalone `gpt-5.6-sol` / `max` reviewer finished with zero CRITICAL, HIGH, MEDIUM, or LOW
  findings after all earlier checkpoint findings were fixed.

## Do Not Split Protection

- Scheduling, worker-owned materialization, exact revision-prefix normalization, CAS commit, and
  automatic re-arming form one coverage contract. Shipping only the scheduler would recreate stale
  or falsely advanced checkpoints.
- Canonical fitting and its protected-fact rules must ship with the refresh lifecycle; automatic
  growth without deterministic whole-fact eviction would eventually exceed the hard limit.
- Defaults, compatibility migration, IPC validation, and settings copy must remain aligned so an
  existing blank model never silently changes provider behavior.

## Related records

- [PLAN_11](../../plans/recent-3-days/PLAN_11_automatic-continuation-checkpoints.md)
- [REVIEW_160](../../reviews/recent-3-days/REVIEW_160_checkpoint-lifecycle.md)
