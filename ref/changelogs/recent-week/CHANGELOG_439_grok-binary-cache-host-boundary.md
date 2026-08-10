---
changelog_id: 439
changed_at: 2026-08-05
---

# CHANGELOG_439_grok-binary-cache-host-boundary: Host the Grok executable cache

## Summary

The Grok bundled-binary resolver now derives its default executable cache from the installed
application host identity instead of importing Electron. Explicit operator cache overrides retain
their existing resolution behavior.

## Host boundary

- Replaced `app.getPath('userData')` with the immutable application host path contract.
- Added a pure cache-root resolver so a Node-hosted Core can supply its own instance data root and
  tests can verify the mapping without an Electron mock.
- Preserved secure cache materialization, platform-package discovery, explicit binary paths, and
  the `AGENT_DECK_GROK_CACHE_DIR` override.

## Node boundary gate

- Added the complete Grok bundled-binary resolver as an executable Node 22 bundle candidate.
- Added a matching direct-import rule that rejects Electron or desktop logger dependencies.

## Validation

- `mise exec -- pnpm typecheck`: passed, including five executable Node-boundary bundle
  candidates.
- Grok adapter suite: 31 files / 204 tests passed; the focused host-path and Electron-installer
  boundary suite passed 3 files / 17 tests.
- `mise exec -- pnpm build`: passed for main, preload, and renderer production bundles.
- `mise exec -- pnpm test`: 607 files passed plus 1 skipped; 4,729 tests passed plus 1 skipped.
- `git diff --check`, changelog ID/bucket validation, and the changed-file 500-line guard passed.

## Do Not Split Protection

Keep the host-derived cache resolver, its no-Electron regression test, and the executable bundle
candidate together. Moving only the path calculation would not prevent a transitive desktop
dependency from returning to the binary materialization path.

## Remaining boundary

Grok resource discovery, settings, diagnostics, process factories, and the complete concrete
Server Core runtime remain separate extraction slices. No shared development process was touched.
