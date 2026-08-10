---
changelog_id: 502
changed_at: 2026-08-05
---

# CHANGELOG_502_claude-sdk-runtime-core-boundary: Port SDK runtime and binary selection

## Summary

Claude SDK child-runtime and native-binary selection now run in a host-neutral Core. Desktop process
state and Node module resolution remain behind one host while executable, environment, platform
precedence, packaged-path rewriting, and SDK fallback behavior stay stable.

## Host-neutral SDK runtime Core

- Added `sdk-runtime-core.ts` with string-only process-environment copying, forced
  `ELECTRON_RUN_AS_NODE=1`, and explicit executable selection.
- Preserved Claude's Linux native-package order (`musl` before glibc), single-package Darwin and
  Windows selection, Windows `.exe` suffix, and undefined fallback when no package resolves.
- Preserved path-segment-only `app.asar` to `app.asar.unpacked` rewriting without changing dev paths,
  similarly named directories, or an already-unpacked path.

## Thin desktop host and stable facade

- Added `sdk-runtime-host.ts` as the sole owner of `process.env`, `process.execPath`, platform,
  architecture, and `createRequire(__filename).resolve`.
- Reduced `sdk-runtime.ts` to stable Core/Host delegation while retaining its packaging rationale
  and public API used by session creation, usage probes, and binary fallback.
- Added direct Core tests for env filtering, forced Node mode, Linux fallback order, Windows naming,
  missing-package fallback, and exact packed-path rewriting; added a direct desktop-host seam test.

## Executable boundary gate

- Added a direct-import rule rejecting the stable runtime facade, desktop host, repositories, Node
  built-ins, Electron, and electron-log from SDK runtime Core.
- Added Claude SDK runtime Core as the sixty-seventh executable Node 22 boundary candidate.

## Validation

- Focused Core/host, binary resolution, query options, and SDK fork coverage: passed, 5 files / 34
  tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty-seven Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 699 files / 4,935 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep SDK runtime Core, desktop host, stable facade, direct-import rule, and platform/path tests
together. Linux must remain musl-first, resolution failure must retain SDK fallback, asar rewriting
must stay segment exact, and child runtime env must be a copy with Electron Node mode forced.

## Remaining boundary

Claude SDK runtime and native-binary selection are now host neutral. The wider provider output stream
plus concrete provider composition/repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
