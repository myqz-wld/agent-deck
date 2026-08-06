---
changelog_id: 444
changed_at: 2026-08-05
---

# CHANGELOG_444_claude-baseline-store-boundary: Extract Claude baseline file ownership

## Summary

Claude application-convention reads, atomic custom-copy writes, and resets now run in an explicit
Node-only store. The SDK facade retains settings, prompt substitution, append caching, and plugin
mirror publication without changing either session or settings-editor behavior.

## Resource boundary

- Added a synchronous store with explicit bundled and app-owned user paths plus an optional
  diagnostics port.
- Preserved Claude's non-blocking fallback when the bundled baseline is unavailable and observable
  fallback when a custom copy cannot be read.
- Kept the Claude injection toggle, placeholder substitution, prompt cache, and plugin mirror state
  outside the store.

## Node boundary gate

- Added the complete Claude baseline store as the tenth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Electron, desktop logger/settings, application-host, and
  placeholder-wrapper dependencies in the store.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed ten Node 22 bundle
  candidates.
- Focused Claude baseline/plugin coverage: passed, 3 files / 16 tests; the new store and facade
  account for 2 files / 5 tests.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 612 files plus 1 skipped / 4,742 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 96 changelogs, maximum id 444.

## Do Not Split Protection

Keep the explicit store, SDK facade, direct store/facade tests, and executable boundary gate
together. The larger Claude plugin mirror intentionally remains unchanged until its rollback state
machine can move as one unit.

## Remaining boundary

Claude and Codex plugin mirrors, bundled-asset scans, provider process/settings, Browser, and
checkpoint worker transforms remain extraction blockers. No shared development process was
started, restarted, or stopped.
