---
changelog_id: 544
changed_at: 2026-08-05
---

# CHANGELOG_544_claude-can-use-tool-host-injection: Inject Claude tool decisions

## Summary

The Claude create-session orchestrator no longer imports the desktop `makeCanUseTool` facade.
Adapter initialization now supplies the required tool-decision host, and create-session constructs
the existing Core callback directly.

## Single tool-decision composition

- Added `ClaudeCanUseToolHost` to required bridge options and adapter-init composition.
- Threaded the host through create-session dependencies and called `makeCanUseToolCore` directly.
- Replaced the create-session facade-derived callback type with the SDK `CanUseTool` contract.
- Expanded bridge and create-session architecture rules to reject the facade and desktop host.

## Preserved permission behavior

- Read-only and image-read tools remain allowlisted in every permission mode.
- `SandboxNetworkAccess` remains an automatic deny with the same bounded fallback guidance.
- Ask-user, exit-plan, and ordinary permission requests retain their exact pending payloads,
  timeout cleanup, abort settlement, bypass rules, and permission-mode transitions.
- Request identity, timestamps, and sandbox-intercept diagnostics now come only from the injected
  host; diagnostic failure still cannot alter a permission decision.

## Direct evidence

- A bridge-level create-session regression captures the actual SDK `canUseTool` option and proves
  the injected request ID, clock, and sandbox observer are used by live callback branches.
- Existing Core and facade suites retain read-only, sandbox, ask, plan, bypass, timeout, and abort
  behavior coverage.
- Adapter-init tests prove the exact tool-decision host reaches bridge construction.

## Validation

- Focused Core/facade/create/init/query coverage: passed, 8 files / 41 tests.
- Complete Claude adapter coverage: passed, 125 files / 498 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 737 files / 5,030 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 499 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required host, direct Core construction, SDK callback type, observable bridge regression,
and architecture prohibitions together. Reintroducing the facade would rediscover request identity,
wall-clock time, and desktop diagnostics inside the create-session orchestrator.

## Remaining boundary

`create-session-sdk-query.ts` still composes desktop SDK loading, runtime/binary discovery, sandbox,
MCP, query-option, metadata-hook, Gateway-settings, and logging facades. The next bounded slice
should inject one query-execution aggregate host while preserving startup, cancellation, identity,
and cleanup authority.
