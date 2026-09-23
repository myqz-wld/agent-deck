---
plan_id: PLAN_52
title: Relay operational acceptance and Worker packaging repair
status: completed with installed acceptance pending
created_at: 2026-09-16
updated_at: 2026-09-16
completed_at: 2026-09-16
base_commit: 6d7dbbcbb90c78ef7571ac780387071dae39f9a0
related_review: REVIEW_273
---

# Relay operational acceptance and Worker packaging repair

## Goal and constraints

Assess the current Relay mode with actual operational checks and prepare a verified repair for any
confirmed in-scope defect. Preserve the existing application, services, credentials, and Workspace.
Existing process stops, installation, and restarts require exact user approval. Keep live deployment
configuration and secrets outside the repository. Use official deployment verification commands
and the production SSH client; use only the session Browser CLI for Browser work.

## Completed work

1. Read the repository and runtime instructions, deployment contracts, and prior acceptance.
2. Confirmed the installed Desktop matches source commit `540c3319`.
3. Verified the existing Relay service, reproduced the installed Worker startup failure, and
   attempted real SSH handshakes through the configured Desktop connection.
4. Diagnosed an externalized `@iarna/toml` import, repaired the headless build, and added a build
   gate that executes the Worker entrypoint outside the checkout.
5. Ran focused and complete tests, typechecking, headless verification, and macOS packaging.
6. Validated a disposable copy of the new application outside the repository and removed it.
7. Recorded the observed deployment state and explicit live-acceptance limits.

## Validation

The focused suite passed 594 tests; the complete suite passed 6,363 tests with three existing skips.
Typechecking, reproducible headless output, isolated Worker startup, headless verification,
production packaging, relocated packaged Worker checks, and SQLite ABI checks passed.

## Handoff

The assessment and replacement artifact are complete. The installed application remains unchanged.
The existing Relay is healthy at generation 18, release `git-f6d977adcbd0`, but its Worker is offline.
The source fix and `build/dist/Agent Deck-0.1.0-arm64.dmg` are ready for review.

After explicit approval, resolve the exact current Desktop and Worker targets, stop only those
targets, install the replacement through the supported local installation workflow, and restore the
Worker and its configured Provider supervisor through the official Worker deployment entrypoint.
Warn that stopping Desktop can interrupt the current session. Do not upgrade the remote Relay
implicitly. Then verify the real connection, session creation, message round trips, and reconnect.

Evidence: [Worker packaged startup](../../reviews/recent-week/REVIEW_273_relay-worker-packaged-startup.md).
