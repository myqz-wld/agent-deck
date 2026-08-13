---
changelog_id: 501
changed_at: 2026-08-05
---

# CHANGELOG_501_claude-gateway-sandbox-settings-core-boundary: Port Gateway sandbox derivation

## Summary

Claude Gateway settings-backed sandbox preparation now runs through a host-neutral Core. Desktop
filesystem access and private temporary-file materialization remain behind one host while the
existing create-session API, child environment, sandbox placement, and cleanup behavior stay stable.

## Host-neutral Gateway sandbox settings Core

- Added `gateway-sandbox-settings-core.ts` with the exact passthrough/materialization decision,
  settings-object validation, string-only child environment extraction, environment removal,
  sandbox merge, and settings-backed output contract.
- Kept malformed non-object Gateway settings fail closed before any private file is materialized.
- Made returned cleanup exactly-once and retained the holder rule that detaches cleanup before
  invocation, so a cleanup failure cannot make later lifecycle paths invoke the same cleanup again.

## Thin desktop host and stable facade

- Added `gateway-sandbox-settings-host.ts` as the sole owner of settings-file reads, private `0700`
  temporary directories, exclusive `0600` writes, and best-effort removal/rollback.
- Reduced `gateway-sandbox-settings.ts` to the stable Core/Host facade used by create-session,
  pending cancellation, and stream retirement.
- Added direct Core tests for passthrough, env filtering, derived settings, invalid source shapes,
  exactly-once materialized cleanup, and holder failure semantics; retained the real-filesystem test.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, sandbox facade, desktop
  repositories, Node built-ins, Electron, and electron-log from Gateway sandbox settings Core.
- Added Claude Gateway sandbox settings Core as the sixty-sixth executable Node 22 boundary
  candidate.

## Validation

- Focused Core/facade, query-options, creation-failure, and pending-cleanup coverage: passed, 5 files
  / 23 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty-six Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 697 files / 4,927 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep Gateway sandbox settings Core, desktop host, stable facade, direct-import rule, and private-file
tests together. Gateway env must remain child-only, derived files must stay private and exclusive,
top-level sandbox must be removed only after successful materialization, and cleanup must remain
exactly-once and best effort.

## Remaining boundary

Gateway settings-backed sandbox preparation is now host neutral. The wider provider output stream
plus concrete provider composition/repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
