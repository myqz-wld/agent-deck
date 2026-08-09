---
changelog_id: 479
changed_at: 2026-08-05
---

# CHANGELOG_479_claude-sdk-injection-host-boundary: Port Claude injection discovery

## Summary

Claude SDK injection no longer discovers desktop settings, application paths, or resource
substitution directly. Pure Core owns plugin selection and prompt formatting while an explicit
desktop host supplies those values and paths.

## Host-neutral injection policy

- Added `sdk-injection-core.ts` to select the bundled mirror and an explicitly selected native
  plugin in stable order with exact path deduplication.
- Preserved the zero-work path when both bundled toggles are disabled and the existing behavior when
  mirror installation fails.
- Moved the application-convention header formatting into Core after desktop-owned placeholder
  substitution.

## Explicit desktop discovery host

- Added `sdk-injection-host.ts` to own the three injection settings, resource/user-data paths, and
  markdown placeholder substitution.
- Kept filesystem mirroring, atomic publication/rollback, diagnostics, CLAUDE.md caching, and the
  public facade API in `sdk-injection.ts` while replacing implicit discovery with host calls.
- Preserved existing test-only mirror filesystem injection and settings hot-toggle semantics.

## Executable boundary gate

- Added a direct-import rule rejecting the desktop injection facade/host, CLAUDE.md and mirror
  stores, session/store/runtime hosts, utilities, Node built-ins, Electron, and electron-log from
  Core.
- Added Claude SDK injection policy as the forty-fourth executable Node 22 boundary candidate.
- Added pure selection/formatting and desktop discovery ownership regressions alongside all existing
  mirror failure/rollback tests.

## Validation

- Focused Core/host/facade/query/registry coverage: passed, 7 files / 57 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed forty-four Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 657 files / 4,859 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the injection Core, desktop discovery host, facade host calls, policy/ownership tests,
direct-import rule, and bundle candidate together. Settings/path discovery must not return to the
plugin-selection or prompt-formatting policy.

## Remaining boundary

Provider adapter construction and Claude injection discovery are now host driven. Broader live
runtime/repository paths and Browser registry ownership remain for extraction; real
Linux/SSH/Feishu/provider acceptance remains outside this deterministic slice.
