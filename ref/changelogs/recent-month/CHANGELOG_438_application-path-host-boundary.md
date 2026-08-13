---
changelog_id: 438
changed_at: 2026-08-05
---

# CHANGELOG_438_application-path-host-boundary: Install one host path identity

## Summary

The second Phase 1 Core-extraction slice introduces one immutable application path identity that
can be installed by Electron today and by the concrete Node runtime later. Common data-directory
and Codex bundled-plugin resolution no longer import Electron or derive paths from launch cwd.

## Host path boundary

- Added a bounded, normalized host path contract for application, resources, user-data, and
  packaged-mode identity. One process cannot silently reinstall it for a different host.
- Added an Electron adapter that establishes the application name before reading paths, preserving
  the existing development and packaged user-data location.
- Kept image-upload and provider-usage child paths identical while moving their root ownership to
  the installed host contract.
- Kept Codex plugin discovery behavior identical for development and packaged resources while
  making its resolver directly callable with a Node host.

## Node boundary gate

- Added the host contract, common application paths, and Codex plugin paths as three additional
  executable Node 22 bundle candidates.
- Added matching direct-import rules so Electron or the desktop logger cannot re-enter these
  candidates without failing `pnpm check:architecture`.

## Validation

- `mise exec -- pnpm typecheck`: passed, including the architecture gate and four executable
  Node-boundary bundle candidates.
- Focused application-path, bootstrap, bundled-asset, image-upload, provider-usage, and custom-agent
  suites: 9 files / 63 tests passed.
- `mise exec -- pnpm build`: passed for main, preload, and renderer production bundles.
- `mise exec -- pnpm test`: 607 files passed plus 1 skipped; 4,728 tests passed plus 1 skipped.
- No shared development Electron process was started, restarted, or stopped during this slice.

## Do Not Split Protection

Keep the immutable process identity, Electron installer, migrated consumers, and executable bundle
proof together. A resolver without an installed host identity would fall back to ambient process
state, while an installer without consumers would not reduce the Core dependency graph.

## Remaining boundary

Claude/Grok resources, provider binaries, Browser, settings, logging, and checkpoint worker
transforms remain separate extraction slices. No complete deployable Server Core runtime is claimed.
