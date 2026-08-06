---
changelog_id: 443
changed_at: 2026-08-05
---

# CHANGELOG_443_codex-agents-store-boundary: Extract Codex baseline file ownership

## Summary

Codex application-convention reads, atomic custom-copy writes, resets, and cache invalidation now
run in an explicit Node-only store. The desktop facade retains settings, resource substitution, and
diagnostics while preserving the existing session and settings-editor contracts.

## Resource boundary

- Added a synchronous store with explicit bundled and app-owned user paths plus an optional
  diagnostics port.
- Preserved fail-closed session injection when the bundled baseline is missing, while settings
  reads remain best-effort and observable.
- Kept the Codex injection toggle and placeholder substitution outside the store so filesystem
  ownership does not acquire desktop settings or prompt-rendering dependencies.

## Node boundary gate

- Added the complete Codex baseline store as the ninth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Electron, desktop logger/settings, application-host, and
  placeholder-wrapper dependencies in the store.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed nine Node 22 bundle
  candidates.
- Focused Codex convention/skills coverage: passed, 4 files / 21 tests; the new store and facade
  account for 2 files / 5 tests.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 610 files plus 1 skipped / 4,737 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 95 changelogs, maximum id 443.

## Do Not Split Protection

Keep the explicit store, desktop facade, store/facade tests, and executable boundary gate together.
Moving only the path helpers would leave cache and mutation ownership inside the desktop graph.

## Remaining boundary

Codex skills mirrors, Claude prompt/plugin mirrors, bundled-asset scans, provider process/settings,
Browser, and checkpoint worker transforms remain extraction blockers. No shared development
process was started, restarted, or stopped.
