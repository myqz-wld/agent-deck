---
changelog_id: 620
changed_at: 2026-08-20
---

# CHANGELOG_620_atomic-session-configuration-readiness: Keep adapter switches visually atomic

## Summary

Session-creation surfaces now retain the currently displayed adapter configuration for up to
150 ms while a newly selected adapter is being resolved. A fast Codex read replaces the previous
projection directly with its final model, while a slow read switches to the Codex loading/fallback
projection only after the shared boundary. Session creation also exposes preparation state and
correlated diagnostics instead of appearing to ignore a click.

## Changes

### Atomic adapter presentation

- Added a shared deferred-identity mode alongside the existing initial-load and delayed-progress
  modes. It preserves useful current content during a pending identity switch, commits a completed
  target in the layout phase, and releases a still-pending target after 150 ms.
- Applied that mode to Local new-session and issue-resolution forms and to the shared Remote
  creation authority used by new-session, issue-resolution, and handoff surfaces.
- Kept the adapter selector on the user's new selection while the model/runtime projection remains
  unchanged during the grace window. Schema-sensitive controls are blocked until the held
  projection is released.
- Start adapter changes immediately; retain the 120 ms debounce only for later changes within the
  same adapter selection, so it no longer consumes the 150 ms fast-read window.

### Creation feedback and diagnostics

- Display `正在准备…` and a configuration-read title while authoritative creation options are
  unresolved, instead of leaving a disabled button labelled as if it were actionable.
- Correlate Local create requests from renderer through main IPC, recording received, slow,
  completed, and failed phases without logging the prompt or working directory.
- Add a two-second slow-request marker with the current phase so future reports distinguish input
  validation, attachment persistence, adapter creation, and post-create bookkeeping.
- Reuse the Codex skill mirror prepared during bootstrap or settings application instead of doing
  a recursive mirror synchronization in every new-session creation hot path.

### Global 150 ms audit

- Confirmed the active presentation policy now covers Local/Remote new-session, Local/Remote issue
  resolution, and Local/Remote handoff paths according to whether they perform initial loading or
  adapter revalidation.
- Confirmed the retired Permissions product surface no longer has an active readiness path.
- Left the two unrelated 150 ms Browser process drain/exit timers unchanged; they are lifecycle
  bounds, not renderer presentation policy.

## Validation

- Focused deferred-identity, Local/Remote creation-readiness, Codex skill-mirror, and IPC diagnostic
  tests passed.
- `pnpm typecheck`
- `pnpm test`: 994 files passed and 2 skipped; 6,241 tests passed and 3 skipped.
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`

## Do Not Split Protection

No exception is required. Every changed production TypeScript file remains below 500 lines; the
largest is `src/main/ipc/adapters.ts` at 446 lines.

## Notes

- This is a bug fix and internal diagnostic hardening, so no README workflow change is required.
- Main-process and renderer code changed. The running installed application must be rebuilt and
  restarted before live acceptance; this session intentionally did not stop its own host app.

## Related review

- `ref/reviews/recent-3-days/REVIEW_257_session-creation-readiness-and-stall.md`
