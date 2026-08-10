---
changelog_id: 440
changed_at: 2026-08-05
---

# CHANGELOG_440_codex-binary-host-boundary: Resolve packaged Codex outside Electron

## Summary

Packaged Codex binary and helper-path discovery now read the immutable application host identity
instead of Electron globals. Development fallback and packaged `app.asar.unpacked` layout checks
remain unchanged.

## Host boundary

- Replaced `app.isPackaged` and `process.resourcesPath` reads with the installed host path contract.
- Preserved platform/triple selection, current-layout manifest checks, node_modules fallback, and
  helper `PATH` injection semantics on POSIX and Windows.
- Replaced the Electron test double with a host-contract double, so layout tests exercise the new
  ownership boundary directly.

## Node boundary gate

- Added the complete Codex binary-layout resolver as an executable Node 22 bundle candidate.
- Added a matching direct-import rule that rejects Electron or desktop logger dependencies.

## Validation

- `mise exec -- pnpm typecheck`: passed, including six executable Node-boundary bundle candidates.
- Codex adapter suite: 50 files / 413 tests passed; the packaged binary-layout suite passed all
  11 cross-platform cases.
- `mise exec -- pnpm build`: passed for main, preload, and renderer production bundles.
- `mise exec -- pnpm test`: 607 files passed plus 1 skipped; 4,729 tests passed plus 1 skipped.
- `git diff --check`, changelog ID/bucket validation, and the changed-file 500-line guard passed.

## Do Not Split Protection

Keep the host-owned packaged path, layout regression suite, and executable bundle proof together.
Without the gate, the binary override path could silently regain an Electron-only transitive
dependency and break the future Node-hosted Core.

## Remaining boundary

Codex process construction, settings, hook assets, diagnostics, and the concrete Server Core
runtime remain separate extraction slices. No shared development process was touched.
