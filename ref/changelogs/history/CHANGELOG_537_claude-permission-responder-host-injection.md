---
changelog_id: 537
changed_at: 2026-08-05
---

# CHANGELOG_537_claude-permission-responder-host-injection: Inject Claude permission persistence

## Summary

The Claude bridge no longer constructs the desktop permission-responder facade. Pending response
state remains owned by the existing Core while persistence, publication, diagnostics, and time now
arrive through one required host supplied by adapter initialization.

## Single responder composition

- Added `ClaudePermissionResponderHost` to required bridge options and adapter-init composition.
- Constructed `PermissionResponderCore` directly in the bridge with the injected host.
- Changed create-session and tool-permission dependency contracts to name the Core, not its desktop
  facade subclass.
- Expanded the bridge architecture rule to reject both the responder facade and its desktop host.

## Preserved response behavior

- Permission, question, and exit-plan pending maps retain their existing settlement and timeout
  semantics.
- Approved hot permission switches still update the live query and in-memory mode before persistence.
- Failed hot switches still restore the previous mode and publish the existing user-visible error.
- Bypass approval still interrupts the old turn and delegates its cold restart through the existing
  restart controller.

## Direct evidence

- A bridge-level regression injects an observable responder host, approves an exit-plan hot switch,
  and proves live query update, host persistence, resolver settlement, and in-memory state alignment.
- Adapter-init tests prove the exact responder host reaches bridge construction.
- Existing Core and desktop-host tests retain success, rollback, diagnostic, publication, and clock
  coverage.

## Validation

- Focused responder Core/host/bridge/init coverage: passed, 5 files / 6 tests.
- Complete Claude adapter coverage: passed, 119 files / 490 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 731 files / 5,022 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 497 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required host, direct Core construction, adapter-init wiring, observable-host regression, and
architecture prohibitions together. Reintroducing the facade would rediscover desktop repository,
event, logger, and clock ownership inside the provider bridge.

## Remaining boundary

The Claude bridge still imports provider facades whose Core/host splits can be injected in later
bounded slices. The next dependency inventory should prefer the smallest controller seam while
preserving its protected test surface and lifecycle ordering.
