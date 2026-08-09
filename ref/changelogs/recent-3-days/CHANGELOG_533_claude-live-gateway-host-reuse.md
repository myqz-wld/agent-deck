---
changelog_id: 533
changed_at: 2026-08-05
---

# CHANGELOG_533_claude-live-gateway-host-reuse: Reuse the Claude Gateway host

## Summary

Live Claude provider switching no longer imports the desktop Gateway-profile facade. The bridge now
validates a requested Gateway profile through the same required create/default host that owns
Gateway resolution for session creation and recovery.

## Single Gateway authority

- Removed the direct `gateway-profiles` import from the Claude bridge facade.
- Routed live provider-change validation through `createSessionHost.resolveGatewayProfile`.
- Reused the already-required adapter-init host instead of adding a second settings port or desktop
  lookup.
- Expanded the bridge architecture rule so a future direct Gateway-profile facade import fails the
  boundary gate.

## Preserved live-switch behavior

- Validation still runs only when a live internal session changes provider.
- Native Claude remains represented by a `null` provider and remains valid.
- An active user turn still rejects a Gateway switch before profile resolution.
- Provider/model/thinking persistence, failure rollback, live close, and recovery sequencing remain
  owned by the existing session-model controller.

## Direct evidence

- A bridge test injects a rejecting Gateway resolver, proves that exact resolver receives the
  requested profile, and proves persisted provider/model/thinking values roll back unchanged.
- Existing model-switch and recovery tests retain their previous success, busy-turn, and rollback
  coverage.
- A direct import scan finds no Gateway-profile facade dependency in the Claude bridge.

## Validation

- Focused live-switch coverage: passed, 3 files / 3 tests.
- Complete Claude adapter coverage: passed, 117 files / 488 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 729 files / 5,020 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 497 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the bridge call site, required create/default host, injected-resolver regression, and
architecture prohibition together. A partial change could make new sessions and live switches
resolve the same provider name from different settings authorities.

## Remaining boundary

The Claude bridge still constructs the desktop `SessionModelController` facade, which discovers its
repository, event bus, clock, and logger host internally. Supplying that existing host explicitly is
the next small repository-ownership seam before broader runtime-factory work.
