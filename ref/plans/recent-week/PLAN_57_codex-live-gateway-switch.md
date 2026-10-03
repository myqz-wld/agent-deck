---
plan_id: PLAN_57
title: Codex live Gateway switching
status: completed
created_at: 2026-09-28
completed_at: 2026-09-28
base_commit: 4a9f688effaf723790cd5672c6d30b6344737bac
related_review: REVIEW_279
---

# Codex live Gateway switching

## Goal and constraints

Make Gateway changes on existing Codex sessions take effect on their next turn. Preserve the
session id, conversation history, model/thinking selections, permissions, and active turn.
Do not send a message through stale configuration after a failed refresh. Keep runtime probes
isolated from user credentials and existing application processes.

## Completed work

1. Traced the UI persistence, model controller, staged Gateway options, and thread readiness path.
2. Reproduced native loaded-thread resume ignoring configuration overrides.
3. Added failing regressions and changed readiness to unsubscribe before resuming with a new
   Gateway. Steering retains the active turn and leaves the selection staged for the next turn.
4. Covered shared readiness, rapid selections, default restoration, same-provider profile changes,
   and failures that must remain retryable without sending through the old endpoint.
5. Validated updated production code against native Codex with local Responses fixtures, then
   completed typechecking and the full Electron test suite.

## Validation and handoff

The focused suite passed 58 tests. The full suite passed 6,429 tests with three existing skips.
The native probe verified four successive request destinations and retained conversation history
and thread identity. Typechecking passed and the SQLite binding remained unchanged.

The user authorized committing and pushing the completed repair. The installed application
requires a later authorized update/restart to load the changed main-process code.

Evidence: [Gateway switch repair](../../reviews/recent-week/REVIEW_279_codex-live-gateway-switch.md).
