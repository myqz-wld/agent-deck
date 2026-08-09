---
changelog_id: 471
changed_at: 2026-08-05
---

# CHANGELOG_471_codex-usage-snapshot-host-boundary: Port background quota composition

## Summary

Background Codex quota reads no longer discover desktop settings, application paths, process
environment, or the desktop app-server factory from their Core path. The existing cache, timeout,
quota translation, and public facade now compose through an explicit desktop host.

## Host-neutral usage snapshot

- Extracted CLI override normalization, probe identity, cache policy, timeout selection, SDK-origin
  injection, and usage-store orchestration into `usage-snapshot-core.ts`.
- Kept explicit test/caller overrides ahead of host discovery and retained the production default
  that injected clients are transient while desktop-created clients are briefly cached.
- Cloned the host environment snapshot before binding `AGENT_DECK_ORIGIN=sdk`, preventing caller or
  process-environment mutation.

## Explicit desktop host and stable facade

- Moved settings access, provider-usage cwd discovery, process environment capture, and diagnosed
  desktop app-server construction into `usage-snapshot-host.ts`.
- Kept `usage-snapshot.ts` as the stable API used by the SDK bridge and existing callers.
- Made cwd discovery lazy so importing the facade does not eagerly access desktop path state or
  break consumers that never perform a background quota read.

## Executable boundary gate

- Added a direct-import rule rejecting the facade/desktop host, app-server implementation, paths,
  stores, runtime host, desktop utilities, Node built-ins, Electron, and electron-log from Core.
- Added the host-neutral usage snapshot as the thirty-sixth executable Node 22 boundary candidate.
- Added direct Core and desktop-host ownership tests while retaining the complete cache, timeout,
  unavailable, live-client, and SDK bridge regression coverage.

## Validation

- Focused usage boundary: passed, 5 files / 19 tests.
- Lazy desktop-path import regression matrix: passed, 9 files / 107 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty-six Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 641 files / 4,837 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the Core usage composition, desktop host, stable facade, store, cache/timeout regressions,
lazy-import coverage, direct-import rule, and bundle candidate together. Background quota reads must
not regain implicit desktop settings, path, environment, or client-factory discovery.

## Remaining boundary

Codex background usage composition is now host driven. The oneshot instance pool and several
Claude/Grok provider paths still read desktop settings directly; Browser registry ownership and real
Linux/SSH/Feishu/provider acceptance remain outside this deterministic slice.
