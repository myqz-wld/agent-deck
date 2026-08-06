---
changelog_id: 463
changed_at: 2026-08-05
---

# CHANGELOG_463_checkpoint-backlog-worker-host-boundary: Port backlog worker construction

## Summary

The continuation-checkpoint backlog RPC client no longer imports Electron-Vite's `?nodeWorker`
transform or the concrete SQLite estimator. Worker construction now belongs to an explicit desktop
host adapter, and the host-neutral client is published as an executable Node 22 boundary candidate.

## Explicit worker host

- Moved the `?nodeWorker` transform, fixed worker name, and worker-data handoff into
  `checkpoint-backlog-worker-host.ts`.
- Made the core client fail closed with a fixed error when no worker host is supplied; production
  checkpoint refresh now selects the desktop adapter explicitly.
- Moved the bounded backlog result shape and source ceilings into the worker contract so the RPC
  client no longer pulls in SQLite repositories and normalization code through a type import.
- Preserved single-worker serialization, generation fencing, abort behavior, ready/stop watchdogs,
  termination barriers, exact protocol messages, and desktop production worker identity.

## Executable boundary gate

- Added a direct-import rule rejecting the concrete estimator, desktop worker host, transform,
  stores, and desktop utilities from the host-neutral client.
- Added the checkpoint backlog worker client as the twenty-eighth executable Node 22 bundle
  candidate.
- Added regressions proving an unconfigured client fails closed and the desktop adapter supplies the
  exact `agent-deck-checkpoint-backlog` name and versioned worker data.

## Validation

- Focused backlog client, desktop host, and refresh-service coverage: passed, 3 files / 22 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed twenty-eight Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed; the backlog worker remains a separate production chunk.
- Canonical Electron full suite: passed, 628 files / 4,816 tests plus 1 skipped.
- `git diff --check`, empty cached diff, logger check, changed TS/TSX line guard, and global changelog
  validation: passed; 115 structured changelogs, maximum id 463.

## Do Not Split Protection

Keep the host-neutral contract/client, desktop transform adapter, production refresh composition,
fail-closed test, exact worker-identity test, direct-import rule, and executable bundle gate together.
The client must not regain an implicit desktop transform or concrete SQLite-estimator dependency.

## Remaining boundary

The backlog RPC client now bundles under plain Node. The background checkpoint and storage
maintenance clients still import Electron-Vite worker transforms, and the larger concrete Core still
needs provider settings/composition, Browser registry ownership, authoritative repositories, and
real Linux/provider acceptance. No shared development or Electron process was started, restarted,
stopped, or killed.
