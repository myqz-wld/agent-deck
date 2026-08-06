---
changelog_id: 448
changed_at: 2026-08-05
---

# CHANGELOG_448_claude-plugin-mirror-store-boundary: Extract Claude plugin publication

## Summary

Claude's bundled plugin mirror prepare, filter, transform, validate, publish, rollback, cache, and
cleanup state machine now runs in an explicit Node-only store. The SDK facade retains settings,
application paths, Markdown substitution policy, logging format, and final plugin-list composition.

## Publication boundary

- Added a synchronous store with explicit source/destination, filesystem, Markdown-transform,
  diagnostic, and operation-tag ports.
- Preserved unique same-filesystem staging, old-reader continuity, complete-tree validation before
  publication, backup ownership, rollback on publish failure, and preservation of the only valid
  backup when rollback itself fails.
- Preserved source-missing omission, successful-publication-only caching, stale live-mirror
  revalidation, skills/agents pruning, retry after failure, and bounded operation-artifact cleanup.
- Kept the existing test filesystem injection seam by recreating the store and clearing its
  publication cache whenever tests replace filesystem operations.

## Node boundary gate

- Added the Claude plugin mirror store as the fourteenth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Electron, desktop settings/logger, application-host, and
  placeholder-wrapper dependencies in the store.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fourteen Node 22 bundle
  candidates.
- Focused store/facade/baseline coverage: passed, 3 files / 17 tests; the new store accounts for
  1 file / 4 tests and the original 11 publication/rollback tests remain green.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 617 files / 4,758 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 100 structured changelogs, maximum id 448.

## Do Not Split Protection

Keep the publication store, SDK facade delegation, structured diagnostics, filesystem reset seam,
direct store/facade tests, and executable boundary gate together. Staging and rollback ownership
must remain one synchronous state machine.

## Remaining boundary

Codex skills publication, provider process/settings, Browser, and checkpoint worker transforms
remain extraction blockers. No shared development process was started, restarted, or stopped.
