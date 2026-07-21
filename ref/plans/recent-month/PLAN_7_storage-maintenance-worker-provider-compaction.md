---
plan_id: PLAN_7
title: Dedicated storage maintenance worker and provider compact runtime
status: completed
created_at: 2026-07-12
updated_at: 2026-07-12
completed_at: 2026-07-12
owner_task_id: 89806703-1c24-44be-a245-e88f9ee60ec5
base_branch: main
base_commit: 4ca882199ff04cb7e9cca761a8566488c7ac6f5d
related_changelog: CHANGELOG_362
related_review: REVIEW_153
---

# PLAN_7_storage-maintenance-worker-provider-compaction: Dedicated maintenance and reliable compact generation

## Goal and invariants

Move every bounded v41 event-search and snapshot maintenance operation off Electron main, including
hashing/compression, writes, and WAL checkpoints, while preserving resumable cursors, bounded WAL,
ingress atomicity, app-restart eligibility, and the no-live-destructive-maintenance rule.

The approved supplemental scope removes Codex `minimal`, restores real Codex summaries and new
Continuation Context checkpoints in a hardened-but-unattested boundary, improves diagnostic fallback,
checks Claude's available effort levels, and updates the targeted provider SDKs.

## Confirmed design

- Persistent bundled worker with one SQLite connection and a versioned, one-request-at-a-time
  protocol; main retains only scheduling, timers, correlation, logging, and WAL lease ownership.
- Freeze restart-eligible tasks once per app run and pass the set unchanged to replacements.
- Acquire main `wal_autocheckpoint=0` only after worker readiness; worker explicitly disables its own
  autocheckpoint and runs periodic PASSIVE checkpoints; restore main's original threshold on every
  exit path.
- Graceful stop queues an independent close request behind a synchronous in-flight operation and
  never calls `terminate()`.
- Revalidate event/snapshot candidates inside short worker write transactions; preserve atomic live
  ingress and use an immediate transaction for snapshot-GC reference/delete safety.
- Keep DROP/index-build/optimize/VACUUM and non-PASSIVE checkpoints unavailable to live worker
  commands. Existing destructive shutdown work remains drain-gated.
- Run Codex summary/checkpoint calls in an empty temporary cwd, read-only and without network,
  provider base config, MCP/dynamic tools, roots, or executable features. Accept checkpoint output
  only after strict schema/evidence/carry-forward/revision/CAS validation.
- Reject Codex `minimal` for new inputs and migrate persisted generator settings to `low`; retain
  historical display compatibility. Keep Claude/Deepseek effort at `low` through `max`.

## Completed checklist

- [x] Map scheduler, shutdown worker, WAL configuration, lifecycle order, and cross-connection races.
- [x] Implement multi-connection-safe event, snapshot, and GC slice helpers.
- [x] Implement persistent maintenance/checkpoint worker, protocol, and atomic main checkpoint lease.
- [x] Integrate async lifecycle stop without weakening the ingress-drained destructive gate.
- [x] Add ready/lease, watchdog, stale reply, lost-reply stop, restart-gate, crash/replacement,
  checkpoint, WAL, integrity, and two-connection race coverage.
- [x] Fix independent review findings for lost-reply shutdown and close/fatal safety.
- [x] Remove Codex `minimal`, migrate legacy settings, and update paired schemas/UI/prompt assets.
- [x] Correct summary diagnostics and enable approved hardened Codex summary/checkpoint execution.
- [x] Fix Codex structured-output schema compatibility and terminal error propagation.
- [x] Confirm Claude exposes no separate `ultra` effort level and update targeted dependencies.
- [x] Run real Codex live smoke, full repository gates, built-worker verification, continuous-ingress
  WAL/responsiveness validation, LOC/review checks, and final standalone review.
- [x] Archive changelog/review/plan records and resolve issue ed009981-889f-4de8-9ba0-1c25e0f67e09.

## Validation and residual risk

- Full test, typecheck, build, logger, diff, built-worker, WAL/ingress, quick-check, FK, and real Codex
  live-smoke gates passed; see REVIEW_153 for measurements.
- SQLite still permits only one writer, so worker transactions remain deliberately short. The final
  continuous-ingress gate bounds observed contention but does not claim proof for every machine.
- Codex 0.144.1 still cannot attest the final built-in registry; this explicitly accepted residual
  risk is documented in settings/README, while output validation remains fail-safe.
- A fresh 1.9 GiB production-shape tail rerun remains release evidence rather than a correctness gate.

## Completion

Implementation, validation, independent review, and durable records are complete. Main/renderer
changes require a safe application restart; this resolution session did not restart the running app.

Archived release-gate harnesses are retained under this plan's `spike-reports/` directory:

- [Built-worker integrity and heartbeat verification](PLAN_7_storage-maintenance-worker-provider-compaction/spike-reports/verify-maintenance-worker-built.mjs)
- [Continuous-ingress latency and WAL high-water benchmark](PLAN_7_storage-maintenance-worker-provider-compaction/spike-reports/benchmark-maintenance-worker-built.mjs)
