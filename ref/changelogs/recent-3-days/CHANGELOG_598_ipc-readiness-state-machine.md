---
changelog_id: 598
changed_at: 2026-08-12
---

# CHANGELOG_598_ipc-readiness-state-machine: Make fast IPC presentation complete and identity-safe

## Summary

New-session, handoff, and permission-detail reads now share a truthful 150 ms presentation rule:
fast asynchronous reads reveal the complete destination component directly, while slower reads
show a bounded loading state without blocking Electron's main process. Later refreshes retain the
last complete projection while current authority is revalidated.

## Changes

### Initial readiness

- Add an identity-aware initial readiness state that resets on reopen, source changes, and Remote
  availability cycles, but does not collapse a settled component during later refreshes.
- Mount modal backdrops immediately so the underlying page cannot be focused or clicked during the
  grace window; reveal either the complete dialog or its loading panel after the boundary.
- Start Local adapter defaults and provider/Gateway discovery before the form is revealed, making
  “complete within 150 ms” cover the whole runtime/model projection.

### Remote creation and handoff authority

- Separate the last complete presentation descriptor from the exact descriptor authorized for
  submission, keyed by source cycle, dialog scope, adapter, provider, and working directory.
- Fence superseded reads and create/preview/commit completions across adapter changes, source
  switches, disconnect/reconnect cycles, and dialog reopen cycles.
- Remove the redundant follow-up capability read caused by a non-empty default provider, preserve
  only explicit still-valid choices during revalidation, and add in-place retry for read failures.
- Keep authoring fields mounted during refresh while blocking only schema-sensitive controls and
  authority-dependent submission.

### Permission detail

- Share one delayed tab-selection state machine between Local and Remote permission views so a
  fast read switches directly to complete content and a slow read switches after the grace period.
- Retain the previous permission projection when a refresh fails and expose retry for initial read
  failures.

## Validation

- Final focused readiness/authority coverage passed 6 files / 43 tests.
- The complete Electron suite passed 957 files / 6,113 tests; 2 files / 3 explicit cases were
  skipped.
- Node/Web TypeScript, architecture/Core-node boundaries, the production build,
  `git diff --check`, and the 500-line production-file gate passed.

## Do Not Split Protection

No exception is required. Shared readiness logic is isolated in small hooks, and every changed
production TypeScript file remains below 500 lines.

## Related review

See `ref/reviews/recent-3-days/REVIEW_238_ipc-readiness-lifecycle-audit.md`.
