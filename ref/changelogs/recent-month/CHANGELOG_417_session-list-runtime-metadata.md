---
changelog_id: 417
changed_at: 2026-07-30
---

# CHANGELOG_417_session-list-runtime-metadata: Show branch and context in session cards

## Summary

Live session cards now expose the current Git branch and provider-reported context occupancy without
requiring users to open each session detail.

## Changes

### Session list metadata

- Show the current Git branch beside model and thinking metadata in every live session card.
- Reuse the context-usage chip from session details, including exact-value tooltips, capacity
  warnings, unavailable telemetry, and the post-compaction `更新中` state.
- Promote the context chip to a shared renderer component so list and detail views cannot drift.

### Branch refresh

- Refresh visible-session branches every ten seconds, matching the detail header cadence.
- Deduplicate branch lookups by working directory so lead and teammate sessions in the same checkout
  share one Git probe per refresh.
- Fence stale asynchronous refreshes and retain known values while the visible session topology is
  refreshed.

### Regression coverage

- Cover active and dormant card metadata, post-compaction context display, and same-cwd branch lookup
  deduplication.

## Validation

- `pnpm typecheck`
- `pnpm test` (479 files passed, 1 skipped; 4,058 tests passed, 1 skipped)
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`

## Do Not Split Protection

All changed production files remain below 500 lines. Branch refresh behavior is isolated in a
renderer hook instead of expanding the session list or detail components.

## Notes

- Branches reflect the repository state at the session working directory; detached HEAD continues
  to use the existing short-commit fallback.
- Context occupancy remains provider telemetry and is not estimated from the visible transcript.
