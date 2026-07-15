---
changelog_id: 370
changed_at: 2026-07-15
---

# CHANGELOG_370_continuation-checkpoint-concurrency: Bound concurrent checkpoint refreshes

## Summary

Continuation Context settings now expose an independent cross-session concurrency limit for
background checkpoint generation. The main-process refresh service enforces that limit and applies
changes immediately without weakening same-session foreground hand-off and recovery priority.

## Changes

### Settings and persistence

- Added “最多同时整理的会话数” to Continuation Context, defaulting to 2 with a supported range of
  1–10.
- Added shared defaults, IPC validation, malformed-persisted-value repair, and hot settings dispatch
  for `continuationCheckpointMaxConcurrent`.

### Background checkpoint runtime

- Replaced the fixed global single-job chain with a FIFO bounded-concurrency queue.
- Kept each individual session single-flight through the existing scheduler while allowing different
  sessions to generate checkpoints concurrently.
- Increasing the configured limit starts queued work immediately; decreasing it lets active work
  finish and holds later jobs until the new bound is satisfied.
- Queued same-session work still cancels promptly when a foreground hand-off or recovery acquires its
  lease, and shutdown still drains running provider work.

### Documentation and tests

- Updated the README to document the default, range, and bounded-concurrency refresh lifecycle.
- Added renderer, IPC, settings-store, configured concurrency, live-resize, cancellation, and shutdown
  regression coverage.

## Validation

- `pnpm typecheck` passed.
- Focused continuation settings/runtime suite: 4 files / 77 tests passed.
- Full suite: 310 files / 2,844 tests passed; one credentialed live smoke remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- A main-process restart was intentionally deferred because the running Agent Deck instance owns this
  implementation session.

## Do Not Split Protection

None. The new queue is isolated in its own module and every changed production TypeScript / TSX file
remains below 500 lines.
