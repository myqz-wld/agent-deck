---
changelog_id: 495
changed_at: 2026-08-05
---

# CHANGELOG_495_claude-hook-installer-core-boundary: Publish hook installation Core

## Summary

Claude hook installation, removal, and status inspection now form an executable Electron-free Node
Core. Desktop logging is injected through one observer while the stable adapter-facing class keeps
its existing constructor and hook contract.

## Host-neutral hook installer Core

- Added `hook-installer-core.ts` with exact v2 ownership tags, event routes, user/project paths and
  modes, tokenless hook commands, private relay preparation, strict shape validation, install,
  uninstall, and read-only status behavior.
- Preserved the complete active event list, wildcard matcher set, user-owned hook retention,
  malformed-config fail-closed behavior, and repairable not-installed status fallback.
- Injected only status-read observation and contained observer failures so diagnostics cannot change
  status authority.

## Thin desktop host and stable facade

- Added `hook-installer-host.ts` as the sole owner of the desktop logger sink.
- Reduced `hook-installer.ts` to a stable subclass wrapper and event-list re-export; bootstrap and
  all existing call sites keep the same three-argument constructor.
- Added direct Core and host tests while retaining literal install/route, partial status, stale tag,
  malformed shape, file-mode, bearer-token isolation, and PostCompact coverage.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, sessions, repositories,
  diagnostics, Electron, and electron-log from hook installer Core.
- Added Claude hook installer Core as the sixtieth executable Node 22 boundary candidate.

## Validation

- Focused Core/host and hook contract coverage: passed, 4 files / 10 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 686 files / 4,906 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep installer Core, desktop observer, stable facade, hook config/relay/curl helpers, direct-import
rule, and contract tests together. Settings must remain tokenless, relay files private, exact v2
tags authoritative, and malformed status repairable without claiming installation.

## Remaining boundary

Claude hook configuration ownership is now an executable Node Core. Message/permission streaming
and concrete provider composition/repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
