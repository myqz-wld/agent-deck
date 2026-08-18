---
changelog_id: 586
changed_at: 2026-08-10
---

# CHANGELOG_586_remote-source-auto-connect: Restore the active Remote source

## Summary

The desktop now reconnects a persisted active Remote source when its initial snapshot is offline.
Capability-backed pages, authoritative session totals, and Remote usage rates therefore recover
without requiring a separate connection-manager click after every application start.

## Changes

- Start one connection attempt when the persisted source is Remote and its selected profile is
  offline.
- Treat connected, connecting, and reconnecting states as an existing attempt so snapshot refreshes
  cannot create a reconnect loop.
- Preserve an explicit disconnect while the current Remote source remains selected.
- Reset the one-shot attempt after switching to Local so selecting Remote again can reconnect.
- Ignore a late connection failure after the user has already changed the active source.
- Add regression coverage for startup restore, explicit disconnect, Local-to-Remote switching,
  bounded failure handling, capability recovery, and stale failure isolation.

## Validation

- `pnpm test` — 876 files / 5,709 tests passed; 2 files / 3 tests skipped.
- Focused Remote source suites — 4 files / 28 tests passed.
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
- Official Relay Server and Relay Worker `--verify` checks passed against `aws-relay-on-mac`.

## Acceptance boundary

This is a desktop renderer lifecycle correction. The already-current Relay Server and macOS Worker
do not require another release change. The signed desktop application must be rebuilt from the clean
pushed commit and installed only after the currently running application exits normally.

## Do Not Split Protection

The one-shot attempt, source reset, stale-result guard, and snapshot application form one lifecycle
boundary. Separating them would risk either reconnect loops or applying a result to the wrong source.
