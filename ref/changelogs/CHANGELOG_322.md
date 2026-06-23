# CHANGELOG_322: Reduce Codex quota and SDK orphan-hook log noise

## Summary

Recent runtime logs showed expected Codex quota read failures being recorded as warnings and returned as generic error snapshots. SDK-derived hook events from hidden provider probes also dominated the default file log at `info`.

## Changes

- Codex quota errors containing `authentication required` now map to an `unavailable` provider snapshot instead of a generic error.
- Live Codex app-server quota reads now reuse the same expected-unavailable classifier as background quota probes.
- Expected Codex quota unavailability is logged at `debug`, keeping it out of the default file log while preserving dev-console diagnostics.
- SDK-derived orphan hook drops are now logged at `debug` instead of `info`.
- Remaining renderer startup `console.warn` calls now use scoped renderer loggers, and a logger comment no longer trips the console-call guard.

## Do Not Split

- `src/main/adapters/codex-cli/sdk-bridge/index.ts` is already over 500 LOC. This change touches only the existing live quota snapshot method; splitting the facade would be unrelated to the runtime log fix and higher risk.

## Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts src/main/session/__tests__/manager-ingest.test.ts src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx`
- `pnpm typecheck`
- `pnpm logger:check`
- `git diff --check`
