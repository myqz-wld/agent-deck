---
changelog_id: 636
changed_at: 2026-09-04
---

# CHANGELOG_636_bundled-only-assets-library: Show only bundled Assets Library entries

## Summary

The Assets Library now shows only Agent Deck's bundled Skills and Agents for Local and Remote
sources. Native user and Plugin assets remain available to their provider runtimes and Local spawn
resolution, but no longer appear in the library or the Remote asset catalog.

## Changes

- Removed the Local user-asset catalog request, loading state, directory hints, empty-state copy,
  and user-asset pagination from the Assets Library.
- Restricted the Server Core catalog to packaged assets and removed its call into the shared
  Provider Home scanner, so current Remote Workers neither enumerate nor return user or Plugin
  assets through the catalog.
- Narrowed the Remote node-asset protocol source to `bundled`; mixed catalogs from older Workers
  and Remote content requests declaring `source: user` now fail contract validation.
- Removed the Desktop's source compatibility filters. Remote presentation now trusts the strict
  protocol result, while the shared Assets tab only applies its adapter selection.
- Updated the project and resource documentation to distinguish the bundled-only library from
  unchanged native runtime discovery.
- Added Local, Remote protocol, and Server Core regression coverage that verifies user assets are
  not requested or returned and that Remote user sources are rejected; retained fixed-page
  coverage for large bundled catalogs.

## Validation

- Focused Assets Library, Remote contract, and Server Core tests — 5 files and 18 tests passed.
- `pnpm typecheck` — passed.
- `pnpm test` — 1,017 files and 6,345 tests passed; 2 files and 3 opt-in tests skipped.
- `git diff --check` — passed.

## Do Not Split Protection

No exception is required. The changed production TypeScript files remain below 500 lines, and the
asset-list responsibilities are already separated between the dialog, tab, card, and Remote
presentation modules.

## Notes

Desktop-local user-asset discovery, content IPC, provider-native loading, and custom Agent spawn
resolution remain intact. Remote Agent selection already resolves only bundled Agents; this change
also makes its asset catalog bundled-only at the source. The shared scanner remains in use by Local
Worker projection, which preserves provider-native loading inside the isolated Provider Home.
Mixed asset catalogs from older Remote Workers are deliberately unsupported.
