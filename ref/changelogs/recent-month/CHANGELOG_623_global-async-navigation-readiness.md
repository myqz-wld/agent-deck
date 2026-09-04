---
changelog_id: 623
changed_at: 2026-08-21
---

# CHANGELOG_623_global-async-navigation-readiness: Stabilize asynchronous navigation globally

## Summary

History and the other asynchronous navigation surfaces now follow one 150 ms presentation rule:
fast reads commit their completed destination directly, the prior complete workspace remains visible
and inert while a destination is unresolved, and slow reads expose a stable loading fallback only at
the shared boundary.

## Changes

### Top-level navigation

- Keep Local History, Issues, and Pending surfaces mounted offscreen so their bounded reads can
  preload and their filters, rows, and selection state survive tab switches.
- Distinguish unresolved Remote History and Pending pages from authoritative empty results.
- Retain and inert the prior workspace while History, Issues, Pending, or a Remote session detail is
  still inside the fast-read window.
- Preserve settled History and Issue rows during revalidation, delay refresh status, and avoid
  enabling actions against a stale projection.
- Track completion of the Local pending snapshot so the header and Pending tab do not report a false
  zero/empty state during startup.

### Nested asynchronous surfaces

- Apply the same delayed fallback to activity, tasks, summaries, cross-session messages, Issue
  detail, Settings, the Assets Library, and Local application-convention editors.
- Retain the last settled Remote application-convention adapter projection for 149 ms, switch
  directly to a fast target, and reveal the target loading state at 150 ms when it remains pending.
- Keep explicit operation progress immediate for load-more, diff selection, image loading, log
  refresh, and directory browsing; those are user-started operations rather than incomplete initial
  navigation projections.

### Structure

- Extract the Remote Pending surface, the Assets Library tab button, and Remote Hook availability
  helper so every production source file remains within the 500-line guardrail.

## Validation

- Focused readiness, navigation, Local/Remote parity, Settings, Assets, and detail-panel coverage
  passed.
- Complete `pnpm test` passed 1,001 files and 6,262 tests; 2 files and 3 opt-in tests were skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- Production TypeScript/TSX file-size inspection found no changed file above 500 lines.

## Do Not Split Protection

No exception is required. The new Remote Pending and small shared presentation helpers keep all
changed production files at or below 500 lines.

## Related review

See `ref/reviews/recent-3-days/REVIEW_260_global-async-navigation-readiness.md`.
