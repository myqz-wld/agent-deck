---
changelog_id: 446
changed_at: 2026-08-05
---

# CHANGELOG_446_resource-placeholder-transformer-boundary: Extract resource placeholder transforms

## Summary

Agent Deck resource-placeholder discovery and substitution now run in a deterministic Node-only
transformer. The desktop wrapper retains application-resource resolution and diagnostic logging,
so all Claude, Codex, and bundled-asset callers keep their existing behavior.

## Transformation boundary

- Added pure functions for canonical placeholder replacement with a caller-owned resource root and
  stable first-seen discovery of unknown Agent Deck placeholder literals.
- Preserved strict-bracket typo matching, canonical-placeholder exclusion, replacement of every
  occurrence, and the no-placeholder fast path.
- Kept application resource-root ownership and warning formatting in the existing desktop facade.

## Node boundary gate

- Added the resource placeholder transformer as the twelfth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Electron, desktop stores/logger, and application-host
  dependencies in the transformer.

## Test determinism

- Tightened the Claude/Codex permission-viewer redaction test to await the second asynchronous open
  failure and its rendered state together instead of observing only the synchronously incremented
  mock call count.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twelve Node 22 bundle
  candidates.
- Focused placeholder, mirror, baseline, bundled-asset, and permission-viewer coverage: passed,
  7 files / 38 tests; the new transformer accounts for 1 file / 4 tests.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite after the deterministic wait repair: passed, 615 files / 4,750
  tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 98 structured changelogs, maximum id 446.

## Do Not Split Protection

Keep the pure transformer, desktop facade delegation, direct transformer tests, and executable
boundary gate together. Resource-path resolution and logging remain host responsibilities rather
than hidden dependencies of the transform.

## Remaining boundary

Codex and Claude plugin publication state machines, bundled-asset scans, provider process/settings,
Browser, and checkpoint worker transforms remain extraction blockers. No shared development
process was started, restarted, or stopped.
