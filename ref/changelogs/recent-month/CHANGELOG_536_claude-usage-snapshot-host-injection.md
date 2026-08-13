---
changelog_id: 536
changed_at: 2026-08-05
---

# CHANGELOG_536_claude-usage-snapshot-host-injection: Inject Claude usage probing

## Summary

The Claude bridge no longer imports the desktop usage-snapshot facade. Live-query selection and
background probing now call the existing usage Core with one required SDK/binary/path/clock host
supplied by adapter initialization.

## Single usage-probe composition

- Added `ClaudeUsageSnapshotHost` to required bridge options.
- Constructed one desktop Claude session-manager port and shared that exact port between normal
  bridge lifecycle and usage-probe hook claims.
- Threaded the usage host through adapter-init Core and desktop composition.
- Called live and background usage Core functions directly from the bridge.
- Expanded the bridge architecture rule to reject both the usage facade and desktop usage host.

## Preserved usage behavior

- The newest usable live query remains preferred and closing sessions remain excluded.
- A missing live query still uses the bounded background SDK probe.
- Background timeout, interactive-auth rejection, abort/close, and delayed hook-claim release remain
  unchanged.
- Binary resolution, runtime environment, probe cwd, and timestamps remain desktop-host owned.
- Raw provider failures still collapse to the existing redacted provider snapshot.

## Direct evidence

- Bridge usage tests now inject an observable usage host instead of mocking the removed facade.
- Background cases prove the injected SDK loader is called; live-query cases prove it is not.
- Existing Core and desktop-host suites retain live/error/background composition coverage.
- Adapter-init tests prove the exact usage host reaches bridge construction.

## Validation

- Focused usage Core/host/bridge/init coverage: passed, 5 files / 9 tests.
- Complete Claude adapter coverage: passed, 118 files / 489 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 730 files / 5,021 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 496 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required host, shared session-manager port, direct Core calls, observable-host tests, and
architecture prohibitions together. Reintroducing the facade could split hook-claim ownership from
the bridge's lifecycle port or rediscover desktop runtime state inside the provider facade.

## Remaining boundary

The Claude bridge still imports several provider facade modules whose Core/host splits already
exist. A direct dependency inventory should choose the next smallest facade that still discovers a
desktop host internally, while preserving controller sequencing.
