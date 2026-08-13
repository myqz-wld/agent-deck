---
changelog_id: 451
changed_at: 2026-08-05
---

# CHANGELOG_451_codex-instance-pool-store-boundary: Extract Codex instance caching

## Summary

The shared oneshot Codex app-server instance cache now runs in a settings-free store with an
explicit configured-path input and client factory. The desktop facade retains settings reads,
process-environment capture, and concrete app-server construction.

## Pool boundary

- Added a synchronous store that normalizes each caller-supplied path, reuses the matching client,
  retires the prior client before a path change, and supports eager invalidation.
- Preserved blank-to-default normalization, trimmed override identity, single-client sharing across
  summarizer and continuation callers, and SDK-origin environment ownership in the facade.
- Preserved fail-closed retirement behavior: a throwing dispose keeps the old cache identity and
  prevents a replacement from being exposed.
- Preserved retry after client construction failure without caching a partial instance.

## Node boundary gate

- Added the Codex instance pool store as the seventeenth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Node builtins, Electron, app-server implementation,
  desktop settings, runtime-host, and utility singleton dependencies in the store.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventeen Node 22 bundle
  candidates.
- Focused store/facade coverage: passed, 2 files / 9 tests; the new store accounts for 1 file /
  7 tests and both original facade regressions remain green.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 620 files / 4,776 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 103 structured changelogs, maximum id 451.

## Do Not Split Protection

Keep the pool store, desktop delegation, construction/retirement tests, and executable boundary
gate together. Cache identity, retirement ownership, and retry behavior form one process-lifecycle
contract.

## Remaining boundary

Additional provider settings/process ownership, Browser, and checkpoint worker transforms remain
extraction blockers. No shared development process was started, restarted, or stopped.
