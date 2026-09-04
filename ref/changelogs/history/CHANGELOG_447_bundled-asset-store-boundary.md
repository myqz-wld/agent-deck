---
changelog_id: 447
changed_at: 2026-08-05
---

# CHANGELOG_447_bundled-asset-store-boundary: Extract bundled asset filesystem ownership

## Summary

Bundled Claude, Codex, and Grok agent/skill scanning, exact adapter-native path lookup, raw content
reads, metadata construction, and bundled-name validation now run in an explicit Node-only store.
The desktop facade retains root discovery, packaged cache policy, placeholder rendering, runtime
overrides, and diagnostic formatting.

## Asset boundary

- Added a filesystem-ported store that scans caller-provided adapter roots, parses Markdown
  frontmatter and Codex TOML, and returns stable adapter-qualified snapshots.
- Preserved Claude/Codex/Grok ordering, same-name isolation, exact Codex `.toml` versus other
  adapter `.md` resolution, skill-directory checks, and fail-closed bundled-name validation.
- Kept user-asset metadata builders compatible through the existing facade export while reducing
  the Electron-aware facade from 318 to 184 lines.
- Added structured scan diagnostics so logging policy remains outside the store.

## Node boundary gate

- Added the bundled asset store as the thirteenth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Electron, adapter/root facades, desktop stores/logger,
  application-host, and placeholder-wrapper dependencies in the store.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirteen Node 22 bundle
  candidates.
- Focused store/facade/user-asset/IPC coverage: passed, 4 files / 17 tests; the new store accounts
  for 1 file / 4 tests.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 616 files / 4,754 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 99 structured changelogs, maximum id 447.

## Do Not Split Protection

Keep the filesystem store, desktop facade delegation, direct store/facade tests, user-builder
compatibility export, and executable boundary gate together. Packaged caching and runtime override
application remain facade concerns rather than hidden store state.

## Remaining boundary

Codex and Claude plugin publication state machines, provider process/settings, Browser, and
checkpoint worker transforms remain extraction blockers. No shared development process was
started, restarted, or stopped.
