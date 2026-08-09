---
changelog_id: 449
changed_at: 2026-08-05
---

# CHANGELOG_449_codex-skills-mirror-store-boundary: Extract Codex skills publication

## Summary

Codex's bundled skills mirror inspect, prepare, transform, validate, publish, rollback, exposure,
and cleanup state machine now runs in an explicit Node-only store that reuses the extracted
manifest codec. The facade retains settings, application paths, Markdown policy, diagnostics, and
extra-root composition.

## Publication boundary

- Added a synchronous store with explicit source/destination, filesystem, Markdown-transform,
  diagnostic, and operation-tag ports.
- Preserved source-versus-live content validation, canonical manifest publication, unique
  same-filesystem staging, synchronous reentrant publishers, old-reader continuity, backup
  ownership, and rollback on publish failure.
- Preserved invalid/partial live-tree removal, valid prior mirror retention when the source is
  missing, nested-publisher recovery, disabled-setting removal, and no extra-root exposure after an
  uncertain publication.
- Kept the existing test filesystem seam by recreating the store whenever filesystem operations are
  replaced.

## Node boundary gate

- Added the Codex skills mirror store as the fifteenth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Electron, desktop settings/logger, application-host, and
  placeholder-wrapper dependencies in the store.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifteen Node 22 bundle
  candidates.
- Focused store/manifest/facade coverage: passed, 3 files / 20 tests; the new store accounts for
  1 file / 4 tests and all 12 original publication/reentrancy/rollback tests remain green.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 618 files / 4,762 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 101 structured changelogs, maximum id 449.

## Do Not Split Protection

Keep the publication store, manifest codec, facade delegation, filesystem reset seam, direct
store/codec/facade tests, and executable boundary gate together. Reentrant publication, backup
ownership, and extra-root exposure must remain one coherent synchronous protocol.

## Remaining boundary

Provider process/settings, Browser, and checkpoint worker transforms remain extraction blockers.
No shared development process was started, restarted, or stopped.
