---
changelog_id: 464
changed_at: 2026-08-05
---

# CHANGELOG_464_checkpoint-background-worker-host-boundary: Port background worker construction

## Summary

The background checkpoint source no longer imports Electron-Vite's `?nodeWorker` transform or the
concrete SQLite materializer. Worker construction now belongs to an explicit desktop host adapter,
and the bounded source client is published as an executable Node 22 boundary candidate.

## Explicit worker host

- Moved the `?nodeWorker` transform, fixed worker name, and worker-data handoff into
  `checkpoint-background-worker-host.ts`.
- Made the source client fail closed with a fixed error when no worker host is supplied; production
  background refresh now selects the desktop adapter explicitly.
- Moved materialization ceilings and the bounded metadata DTO into the worker contract so the
  client no longer pulls SQLite readers, normalization, and WAL materialization into its runtime
  bundle.
- Preserved ready/chunk/fatal validation, wire-byte guards, abort/deadline behavior, generation-safe
  termination, terminate-rejection exit barriers, exact protocol messages, and desktop identity.

## Executable boundary gate

- Added a direct-import rule rejecting the concrete materializer, desktop worker host, transform,
  stores, and desktop utilities from the host-neutral client.
- Added the background checkpoint worker client as the twenty-ninth executable Node 22 bundle
  candidate.
- Added regressions proving an unconfigured client fails closed and the desktop adapter supplies the
  exact `agent-deck-checkpoint-background` name and versioned worker data.

## Validation

- Canonical Electron focused background client, host, materializer, refresh, and emitted-worker
  integration coverage: passed, 5 files / 19 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-nine Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed; the background worker remains a separate production chunk.
- Canonical Electron full suite: passed, 629 files / 4,818 tests plus 1 skipped.
- `git diff --check`, empty cached diff, logger check, changed TS/TSX line guard, and global changelog
  validation: passed; 116 structured changelogs, maximum id 464.

## Do Not Split Protection

Keep the host-neutral contract/client, desktop transform adapter, production refresh composition,
fail-closed test, exact worker-identity test, direct-import rule, and executable bundle gate together.
The source client must not regain an implicit desktop transform or concrete materializer dependency.

## Remaining boundary

Both checkpoint worker clients now bundle under plain Node. Storage maintenance still imports an
Electron-Vite worker transform, and the larger concrete Core still needs provider
settings/composition, Browser registry ownership, authoritative repositories, and real
Linux/provider acceptance. No shared development or Electron process was started, restarted,
stopped, or killed.
