---
changelog_id: 497
changed_at: 2026-08-05
---

# CHANGELOG_497_claude-can-use-tool-core-boundary: Port tool permission decisions

## Summary

Claude tool-permission routing, pending-request state, timeout registration, and abort cleanup now
run in a host-neutral Core. Desktop request IDs, wall clock, and sandbox-intercept diagnostics are
injected through one host while the existing bridge API remains stable.

## Host-neutral can-use-tool Core

- Added `can-use-tool-core.ts` with the read-only allowlist, image-read suffix policy,
  SandboxNetworkAccess denial and fallback guidance, AskUserQuestion presentation, ExitPlanMode
  decision semantics, bypass short-circuit, ordinary permission requests, timeout registration, and
  abort cancellation events.
- Preserved approve-plus-plan denial, approve-bypass interruption, live permission-mode reads,
  resolver cleanup, question formatting, pending-map ownership, and every existing user-facing
  response.
- Made request identity, event time, and the one sandbox diagnostic explicit host ports; diagnostic
  failure cannot alter the authoritative denial.

## Thin desktop host and stable facade

- Added `can-use-tool-host.ts` as the sole owner of `randomUUID`, the wall clock, and desktop logging.
- Reduced `can-use-tool.ts` to a stable Core/Host wrapper, so create-session and all existing tests
  retain the same import and call shape.
- Added direct Core tests for deterministic request identity/time and best-effort diagnostics, plus
  a host test for UUID, clock, and exact diagnostic forwarding.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop host, repositories, diagnostics,
  Node built-ins, Electron, and electron-log from can-use-tool Core.
- Added Claude can-use-tool Core as the sixty-second executable Node 22 boundary candidate.

## Validation

- Focused Core/host and existing permission/ExitPlan coverage: passed, 4 files / 19 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty-two Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 690 files / 4,911 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep permission Core, desktop host, stable facade, pending maps/responders, direct-import rule, and
permission/Ask/ExitPlan/abort tests together. Sandbox interception must remain denied before bypass,
approve-plus-plan must never allow ExitPlanMode, and aborted requests must leave no actionable row.

## Remaining boundary

Claude tool-permission decisions are now host neutral. Stream processing plus concrete provider
composition/repository ownership remain, alongside real Linux/SSH/Feishu/provider acceptance.
