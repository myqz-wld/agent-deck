---
changelog_id: 432
changed_at: 2026-08-04
---

# CHANGELOG_432_diff-history-and-runtime-diagnostics: Keep diffs current and make runtime delays diagnosable

## Summary

The session Diff tab now follows new changes until the user deliberately browses history, resets
immediately across cwd/worktree boundaries, and explains what an older-history page actually added.
Runtime diagnostics now distinguish successful slowness or partial progress from operational
failure and expose content-free timing across worktree transitions.

## Diff history

- Follow the globally newest change by default while preserving an explicitly selected historical
  file or revision.
- Show a fixed `有新改动，查看最新` action when newer changes arrive during history browsing.
- Reset list, selection, and payload caches before paint when one session changes cwd/worktree.
- Split summary-list and selected-payload loading so each request has an independent generation
  fence and cache lifetime.
- Rename pagination controls to `加载更早改动` and keep a persistent result such as the number of
  older records, newly discovered files, total loaded records, and whether history is exhausted.

## Runtime diagnostics

- Add run-scoped, content-free session correlation and phase timing for accepted worktree tool
  results, cwd switching, persistence, cleanup, continuation delivery, and first provider activity.
- Record expected Codex accepted-turn recycling at info instead of warning severity.
- Treat successful provider-usage reads from four to five seconds as slow info; errors and timeouts
  remain warnings.
- Treat successful slow checkpoint refresh and advancing partial coverage as info; stalled partial
  coverage, failures, and timeouts remain warnings with bounded revision counts.
- Add bootstrap stage plus safe error name, message, code, and fingerprint without persisting paths,
  URLs, secrets, or stack content.
- Use durable event-row ids for historical activity identity and a complete fallback digest for
  live-only events, with generic duplicate protection in the renderer store.

## Validation

- Focused Diff, event-store, provider-usage, checkpoint, worktree, Codex recycle, bootstrap, and
  correlation tests.
- Full Electron-ABI suite: 469 files and 3,866 tests passed; one credentialed live smoke skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check`.
- Production-file size check; the changed worktree coordinator remains below 500 lines.

## Do Not Split Protection

The Diff list, selection, and payload hooks form one request-fencing and follow-latest contract.
Worktree phase logs, run-scoped correlation, and severity classifiers form one diagnostic contract;
splitting either group would reintroduce stale UI state or misleading partial telemetry.

## Notes

No database schema or public IPC payload changed. The preload event-history type now reflects the
durable id already returned by the existing repository query.

Related review: `REVIEW_214_diff-history-and-runtime-diagnostics.md`.
