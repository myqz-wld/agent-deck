---
changelog_id: 491
changed_at: 2026-08-05
---

# CHANGELOG_491_claude-usage-snapshot-host-boundary: Port bounded account probing

## Summary

Claude live/background account-usage probing no longer discovers desktop paths, session claims,
runtime options, binaries, or SDK modules inside its policy. A host-neutral Core owns live-query
selection and the bounded idle-query protocol while a desktop host supplies runtime dependencies.

## Host-neutral usage Core

- Added `usage-snapshot-core.ts` with newest-live-query selection, expected-close exclusion, generic
  error projection, and host-clock snapshot timestamps.
- Preserved the background probe's idle input stream, initialization-before-usage ordering,
  interactive-authentication fail-closed path, 15-second timeout, abort/close behavior, and delayed
  hook-claim release.
- Kept SDK/runtime/binary/path/claim functions as explicit ports while retaining all existing test
  overrides for deterministic failure and timeout coverage.

## Thin desktop host and facade

- Added `usage-snapshot-host.ts` as the sole owner of SDK loading, Electron-as-Node runtime options,
  binary override resolution, provider probe cwd, session-manager hook claims, and wall clock.
- Reduced the stable usage module to typed Core/Host wrappers; the bridge still injects its explicit
  background fallback, preserving module-mock and live-session behavior.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, binary/runtime/path/session
  ownership, repositories, diagnostics, Node built-ins, Electron, and electron-log from Core.
- Added Claude usage snapshot Core as the fifty-sixth executable Node 22 boundary candidate.

## Validation

- Focused Core/host, live bridge, and background probe coverage: passed, 4 files / 9 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty-six Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 678 files / 4,896 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep usage Core, desktop host, stable facade, live-query caller, timeout helper, direct-import rule,
and live/background/authentication tests together. Closing sessions must never serve usage, and an
interactive control request must terminate the idle probe without creating a user turn.

## Remaining boundary

Claude usage observation is now host neutral. Message/permission processing, transcript discovery,
recovery orchestration, and real Linux/SSH/Feishu/provider acceptance remain.
