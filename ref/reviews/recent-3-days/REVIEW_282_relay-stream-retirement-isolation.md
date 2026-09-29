---
review_id: 282
reviewed_at: 2026-09-28
baseline_commit: e3bdf2b4738168b587a09b30b3e585309a7fd472
expired: false
---

# Relay stream retirement isolation

## Scope

Follow up the intermittent SSH bridge rejection observed during
[Relay recovery](REVIEW_281_relay-runtime-directory-recovery.md). Diagnose the live failure and
repair the transport boundary in both Relay and Worker. No independent reviewers were requested;
the repository review-expiry inventory was consulted.

```review-scope
src/hosts/relay/router.ts
src/hosts/relay/control-host-retirement.test.ts
src/hosts/local-worker/frame-bridge.ts
src/hosts/local-worker/frame-bridge-retirement.test.ts
```

## Finding: HIGH — Stream retirement disconnects the shared Worker attachment

With automatic retries disabled, three of sixteen production SSH connections fail before receiving
any response bytes. Successful connections read the session list and creation descriptors. This is
a reproducible failure, not sufficient evidence for a network-only explanation.

A second live probe holds one connection open while repeatedly connecting, reading, and closing a
separate connection. Closing a test connection disconnects the held connection and replaces the
Worker SSH child process. The Worker service itself stays running. This explains why launchd and
Relay health checks can pass while a subsequent handshake fails.

At the transport layer, stream closure and packets in flight travel independently. Relay immediately
removes the stream on client retirement; a later Worker frame for that stream throws out of the
attachment peer and terminates the shared Worker connection. Worker has the symmetric defect:
after Core closes a stream, a late Relay frame throws out of its frame bridge.

Eight deterministic regression cases fail on the original source: late data, credit, close, and
reset frames at each endpoint. The Relay cases also prove that an unrelated live client is affected.

## Repair

After validating the frame and authenticated attachment identity, ignore packets for a stream that
is no longer present. This matches the existing terminal-stream behavior in the client bridge,
does not retain an unbounded tombstone collection, and cannot reopen a stream. Invalid instance,
generation, and direction remain rejected; six additional regressions protect these boundaries.

## Validation and deployment status

- After the initial repair, 48 focused transport files and 268 tests passed, including the eight
  previously failing regressions.
- Typechecking passed after adding the identity-boundary regressions.
- The shared checkout full run passed 6,477 tests with three existing skips. Concurrent unrelated
  renderer changes entered that checkout during validation, so this is not exact-release coverage.
- Isolated full validation, headless release build, macOS packaging, and deployment follow the
  source commit. The four changed source/test files are below 500 lines.
- The installed Worker still contains the defect until its packaged runtime is replaced. Replacing
  the hosting application and restarting Desktop require exact user approval after the replacement
  artifact is ready. Existing Relay/Worker recovery authorization does not authorize that Desktop
  installation action.

## Residual limits

The source mechanism and live multi-client failure are established. Final live acceptance must
exercise both repaired endpoints, keep an independent client online during connection churn, and
check handshake success with retries disabled. This record does not claim that every Relay or
provider behavior has been exhaustively validated.
