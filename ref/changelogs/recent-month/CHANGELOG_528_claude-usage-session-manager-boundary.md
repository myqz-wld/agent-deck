---
changelog_id: 528
changed_at: 2026-08-05
---

# CHANGELOG_528_claude-usage-session-manager-boundary: Inject Claude usage ownership

## Summary

Claude live/background usage snapshot composition no longer imports the desktop SessionManager
singleton. The usage host now receives the adapter-owned manager port, leaving the unique adapter
initialization host as the only production Claude singleton binding.

## Read-only ownership injection

- Replaced the usage snapshot singleton host with a factory over the exact `expectSdkSession`
  manager subset.
- Passed the bridge-owned manager into both live-query selection and background-probe fallback.
- Kept SDK loading, runtime environment, binary resolution, probe cwd, clock, and hook-claim timing
  in the existing desktop usage host.
- Preserved dependency overrides used by deterministic background-probe tests without allowing them
  to replace the production manager object accidentally.

## Preserved quota and hook ordering

- The newest non-closing live query remains authoritative and avoids starting a background probe.
- When no usable live query exists, the background path claims the probe cwd before loading the SDK
  and releases that claim only after the existing hold window.
- Initialization still precedes the experimental usage request; interactive authentication aborts
  and returns the same redacted error snapshot.
- Timeout, query close, prompt drain, binary, and environment semantics are unchanged.

## Direct evidence and architecture gate

- Updated host coverage to prove hook-claim delegation uses the injected manager.
- Updated background and bridge coverage for injected ownership, live preference, fallback, and
  redacted failure behavior.
- Added a static rule rejecting future direct SessionManager imports from the usage host.
- A production import scan now finds SessionManager only in `adapter-init-host.ts`, the intended
  desktop composition root.
- Reused the existing eighty-eighth Node 22 manager-port candidate.

## Validation

- Focused usage/manager coverage: passed, 6 files / 11 tests.
- Complete Claude adapter coverage: passed, 114 files / 484 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 726 files / 5,016 tests plus 1 skipped.
- `sdk-bridge/index.ts` remains at 499 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the usage host factory, manager-bearing readers, bridge binding, tests, and architecture rule
together. A partial change could claim the probe cwd through a different manager instance from the
one that owns live create/recovery sessions.

## Remaining boundary

Claude SessionManager injection is complete: only the desktop adapter initialization root binds the
singleton. The next deterministic slice should return to the remaining concrete Electron-free Core
provider settings/composition or repository ownership gap selected from a fresh dependency scan.
