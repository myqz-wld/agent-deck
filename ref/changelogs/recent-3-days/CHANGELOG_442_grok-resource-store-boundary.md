---
changelog_id: 442
changed_at: 2026-08-05
---

# CHANGELOG_442_grok-resource-store-boundary: Extract Grok resource file ownership

## Summary

Grok convention and plugin-profile file operations now run behind an explicit Node-only resource
store. The Electron desktop wrapper supplies host paths and diagnostics without making filesystem
behavior depend on Electron or desktop logging.

## Resource boundary

- Added an explicit store for packaged baselines, app-owned custom conventions, atomic reset/save,
  and capability-specific plugin mirrors.
- Kept path selection and desktop diagnostics in the existing adapter facade while preserving its
  public API and cached profile behavior.
- Made direct Node Vitest startup use the same stable absolute test resource identity as the
  canonical Electron runner.

## Node boundary gate

- Added the complete Grok resource store as the eighth executable Node 22 bundle candidate.
- Added a direct-import rule that prevents the store from acquiring Electron, desktop logger, or
  ambient application-host dependencies.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed eight Node 22 bundle
  candidates.
- `mise exec -- pnpm exec vitest run src/main/adapters/grok-build`: passed, 32 files / 207 tests;
  direct store/facade coverage passed, 2 files / 4 tests.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 608 files plus 1 skipped / 4,732 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 94 changelogs, maximum id 442.

## Do Not Split Protection

Keep the explicit store, desktop facade, direct store tests, and executable boundary gate together.
Moving only the path helpers would leave the actual resource reads and writes desktop-owned.

## Remaining boundary

Other Claude/Codex resource writers and bundled-asset discovery still carry desktop diagnostics or
settings dependencies. No shared development process was started, restarted, or stopped.
