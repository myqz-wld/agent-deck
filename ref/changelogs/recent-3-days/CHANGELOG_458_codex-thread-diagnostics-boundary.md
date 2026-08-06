---
changelog_id: 458
changed_at: 2026-08-05
---

# CHANGELOG_458_codex-thread-diagnostics-boundary: Port Codex turn watchdog diagnostics

## Summary

The Codex app-server thread state machine no longer imports the desktop logger. First-model event,
watchdog-arm, and watchdog-timeout observations flow through a failure-contained diagnostics port
whose desktop factory preserves the existing log messages and sanitized diagnostic payloads.

## Thread lifecycle boundary

- Added a complete turn-watchdog diagnostics contract plus an inert default for non-desktop hosts.
- Moved scoped logger ownership and the three existing first-model watchdog messages into the
  desktop thread factory.
- Kept allowlisted watchdog payload construction in the state machine, including sanitized thread
  and turn identifiers, timing, notification counts, process generation, bounded stderr metadata,
  and pending RPC state.
- Contained diagnostics failures so they cannot disarm the watchdog, suppress a timeout, prevent
  turn cancellation, alter generation recycling, or interrupt model event delivery.
- Preserved the 90-second default, response-versus-notification acceptance race, one absolute
  deadline, accepted-turn cancellation, malformed-terminal fencing, and no-automatic-replay rule.

## Node boundary gate

- Added the Codex app-server thread state machine as the twenty-fourth executable Node 22 bundle
  candidate.
- Added a direct-import rule that rejects the desktop diagnostics factory, runtime host, store,
  utilities, Node built-ins, Electron, and `electron-log`.

## Validation

- Focused diagnostics-port, client, and first-model watchdog coverage: passed, 3 files / 36 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-four Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 625 files / 4,805 tests plus 1 skipped.
- `git diff --check`, empty cached diff, logger check, changed TS/TSX line guard, and global changelog
  validation: passed; the client and thread state machine are each 498 lines, 110 structured
  changelogs, maximum id 458.

## Do Not Split Protection

Keep the diagnostics port, desktop thread factory, thread state machine, client construction,
watchdog regressions, and executable boundary gates together. Watchdog observation, cancellation,
and generation recycling share one acceptance deadline and must not drift.

## Remaining boundary

The Codex app-server client still owns process I/O diagnostics through desktop logger singletons.
Other provider process/settings ownership, Browser registry/tab ownership, and the checkpoint
worker transform remain extraction blockers. No shared development process was started, restarted,
stopped, or killed.
