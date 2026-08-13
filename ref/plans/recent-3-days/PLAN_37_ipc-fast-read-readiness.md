---
title: IPC fast-read readiness repair
status: completed
created_at: 2026-08-12
updated_at: 2026-08-12
completed_at: 2026-08-12
related_changelog: CHANGELOG_598
related_review: REVIEW_238
base_commit: 082f2ef27eb231091dc516f13f739fb11641f9c8
---

# PLAN_37_ipc-fast-read-readiness: IPC Fast-Read Readiness Repair

## Goal

Make the existing 150 ms IPC presentation rule truthful and consistent for new-session, handoff,
and permission-detail flows: a fast asynchronous read reveals one complete component, while a
slower read reveals a stable loading fallback without blocking Electron's main process.

## Context and invariants

- Filesystem and IPC work stays asynchronous; 150 ms is a renderer presentation boundary only.
- Readiness-required child IPC starts before the gated component can become visible.
- Successful results commit atomically for the exact source cycle, authoring scope, adapter,
  provider, and working-directory identity.
- Late or superseded results cannot re-enable creation or replace a newer projection.
- Revalidation keeps the last complete component mounted while authority-dependent actions wait.
- Close/reopen, source/session changes, and disconnect/reconnect cycles start fresh identities.
- Errors are complete presentation states; refresh errors retain previously committed data.

## Task breakdown

- [x] Add an identity-aware initial presentation state and shared delayed-tab selection.
- [x] Fold Local provider discovery into session-creation readiness and key requests by scope.
- [x] Separate Remote authoritative capability data from stable presentation data.
- [x] Remove duplicate provider reads and reconcile only explicit valid overrides.
- [x] Keep modal/focus boundaries immediate and retain complete forms during revalidation.
- [x] Fence stale reads and mutations across source, availability, adapter, cwd, and reopen cycles.
- [x] Retain permission projections on refresh errors and expose retry for initial failures.
- [x] Add timing, supersession, reopen, disconnect/reconnect, and retry coverage.
- [x] Run focused and repository-wide validation and archive final records.

## Validation

- Focused readiness/authority sweep: 6 files / 43 tests passed.
- Complete Electron suite: 957 files / 6,113 tests passed; 2 files / 3 tests skipped.
- `pnpm typecheck`, architecture/Core-node boundaries, and `pnpm build` passed.
- `git diff --check` and the production 500-line limit passed.

## Final status

Completed on 2026-08-12. The grace boundary now controls only presentation, initial components are
complete when revealed, later refreshes preserve stable content without stale authority, and all
identified lifecycle findings are closed in REVIEW_238.
