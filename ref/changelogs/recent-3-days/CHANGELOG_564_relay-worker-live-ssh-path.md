---
changelog_id: 564
changed_at: 2026-08-05
---

# Relay Worker Live SSH Path

## Summary

Ship the concrete Local Worker runtime needed by the isolated Linux artifacts and close the real
Relay-to-Worker-to-desktop SSH path.

## Changes

- Added a packaged Local Worker runtime that composes the concrete Electron-free Server Core and
  exposes its daemon protocol over the bounded Relay frame bridge.
- Made the daemon handshake topology-aware so Relay clients receive a `local-worker` authoritative
  Core descriptor with an exact Worker generation.
- Changed the OpenSSH null-identity sentinel from `/dev/null` to `none`, avoiding a harmless but
  misleading invalid-key warning while retaining `IdentitiesOnly` and explicit key pinning.
- Added the Local Worker runtime artifact to the Linux package manifest, wrapper trust checks,
  static verification, and deployment examples.
- Fixed Relay desktop credential issuance when an authoritative Worker credential already exists;
  internal metadata-only fields are no longer written back into the exact config schema.
- Fixed Relay shutdown with active Worker/client streams by beginning listener shutdown, closing
  routed peers, and then joining listener completion.

## Validation

- `pnpm typecheck`, `pnpm build`, and `pnpm verify:linux-headless` passed.
- The canonical Electron suite passed: 1,772 suites, 5,132 passing tests, one existing skipped test,
  and zero failures. Focused SSH, daemon, Relay, Server Core, and Local Worker tests also passed.
- A real Ubuntu 24.04 ARM64 host ran Relay and Local Worker as bounded user services. The production
  `SshAgentDeckClient` completed HostHello, health, project-list, and session-console-list requests,
  then automatically reconnected and completed health again after a live Relay restart.
- The co-located pre-existing network service retained the same PID, listener, and nftables digest
  throughout the smoke test.

## Evidence Limits

- The live smoke used a small host and direct user services; it did not exercise the delivered
  Podman/Quadlet manager lifecycle, Full topology, SELinux/AppArmor, or multi-instance load.
- No live Feishu tenant, provider mutation, or long-running soak test was performed.

## Do Not Split Protection

No changed ordinary TypeScript or TSX file exceeds 500 lines. The largest is the existing daemon
connection facade at 495 lines; revisit if another lifecycle responsibility is added there.
