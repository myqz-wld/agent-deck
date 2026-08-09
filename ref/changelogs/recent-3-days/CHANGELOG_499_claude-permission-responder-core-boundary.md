---
changelog_id: 499
changed_at: 2026-08-05
---

# CHANGELOG_499_claude-permission-responder-core-boundary: Port pending responses

## Summary

Claude permission, AskUserQuestion, and ExitPlanMode responses plus timeout decisions now run in a
host-neutral Core. Desktop persistence, upsert publication, diagnostics, and wall clock are injected
through one host while the existing PermissionResponder class contract remains stable.

## Host-neutral permission responder Core

- Added `permission-responder-core.ts` with permission/ask/plan response consumption, exact pending
  snapshots, timeout cancellation and resolution, hot permission-mode switching, cold bypass
  restart handoff, optimistic cache mutation, and failure rollback.
- Preserved approve-plus-plan early return, approve-bypass expected-close ordering, timeout copies,
  timer cleanup, duplicate-response no-ops, and cold-restart prompt semantics.
- Made permission-mode persistence, desktop failure diagnostics, and event time explicit host ports;
  diagnostic failure cannot suppress rollback or the user-visible error event.

## Thin desktop host and stable facade

- Added `permission-responder-host.ts` as the sole owner of the session repository, event bus,
  desktop logging, and wall clock.
- Replaced `permission-responder.ts` with a stable subclass facade, preserving constructor, class
  type, inherited methods, and all bridge call sites.
- Added direct Core tests for hot-switch rollback and permission timeout authority, plus a direct
  host test for persistence, publication, diagnostics, and time.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, repositories, event bus,
  diagnostics, Node built-ins, Electron, and electron-log from permission responder Core.
- Added Claude permission responder Core as the sixty-fourth executable Node 22 boundary candidate.

## Validation

- Focused Core/host, can-use-tool, permission-mode rollback, and ExitPlan coverage: passed, 5 files /
  28 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty-four Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 694 files / 4,918 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep permission responder Core, desktop host, stable facade, can-use-tool/pending entry contracts,
direct-import rule, and response/timeout/hot-cold-switch tests together. Approve-plus-plan must not
change mode, bypass must mark expected close before resolution, and failed hot switches must roll
back the in-memory mode and remain visible to the user.

## Remaining boundary

Claude pending responses are now host neutral. The wider provider output stream plus concrete
provider composition/repository ownership remain, alongside real Linux/SSH/Feishu/provider
acceptance.
