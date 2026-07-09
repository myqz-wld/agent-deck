# CHANGELOG_315: Prevent stale provider quota snapshots

## Summary

The Data tab quota window now ignores older provider-usage responses that finish after a newer refresh. Manual hard refreshes also no longer get swallowed by an already-running background quota read.

## Changes

- Added renderer-side provider-usage request ids in the token usage store so only the latest quota request can update `providerUsageSnapshots`, loading, or error state.
- Routed both startup background quota refresh and DataPanel refresh through the request-id guard.
- Split main-process provider usage in-flight state into normal and forced refreshes, so `{ force: true }` starts or joins a forced read instead of reusing an older normal read.
- Guarded the main-process provider usage cache with fetch sequence ids so an older read that finishes late cannot overwrite a newer forced result.
- Added regression tests for out-of-order renderer responses, normal-vs-forced main IPC refresh ordering, and non-forced reads joining an in-flight hard refresh before using cache.

## Validation

- `pnpm exec vitest run src/main/ipc/__tests__/provider-usage.test.ts src/renderer/components/__tests__/DataPanel.test.tsx src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx`
- `pnpm typecheck`
- `git diff --check`

## Related

- Review: `ref/reviews/REVIEW_135.md`
