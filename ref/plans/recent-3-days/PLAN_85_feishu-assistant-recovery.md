---
plan_id: 85
title: Feishu retained assistant recovery and local activation
status: execution-handoff
created_at: 2026-10-12
completed_at: 2026-10-12
base_commit: 9928f3e03bcc8f1cb7a788e56556992ea1dcbaff
related_review: REVIEW_319
---

# Feishu retained assistant recovery and local activation

## Goal and decisions

Restore retained Feishu Codex conversations after their provider lifecycle becomes closed.
The gateway retained the correct identity. Normalized Core error events showed required MCP
initialization failing with HTTP 401: deferred user-input persistence prevented reactivation.
The fix explicitly reactivates deferred recovery after the close-epoch check and retains failure
rollback. MCP authentication, history, permissions, model choice, and work selection are preserved.

## Completed implementation and validation

- Added a reproduction using the real Core session manager and MCP broker; confirmed HTTP 401
  before the repair and successful initialization before user-event acceptance afterward.
- Covered closed and archived identities, exactly one accepted user event, startup rollback,
  and a new close during unarchiving. Existing authentication restrictions remain covered.
- Corrected assistant connection-error guidance to use assistant commands.
- Passed 62 focused tests, typecheck, and 7,114 full-suite tests, with six opt-in skips.
- Passed the application build and reproducible headless build with bundle dependency checks.
- Checked changed-file privacy, local links, and the 500-line source-file limit.

## Authorization and invariants

The owner explicitly approved installing the repair into the existing macOS application,
quitting and reopening it, and pausing/restoring the configured Relay Worker and Provider
supervisor through the installer. These are the only approved runtime targets. Reverify their
exact bundle, executable, launchd definitions, PID, and start-time identities before mutation.
Hosted sessions may be interrupted; the owner has been warned. Do not request the same approval
again. Preserve service definitions, credentials, workspace files, and assistant history.

Local source commits and package preparation support the installer requirement for a clean,
matching release. No upstream push or remote Feishu service upgrade is part of this approval.
The gateway-copy change requires a separate managed runtime upgrade; the assistant recovery
itself runs in the installed application's local Worker.

## Execution handoff

1. Commit the exact validated source and prepare its macOS package.
2. Verify build identity, signatures, native Worker sandbox, archive membership, content privacy,
   and DMG integrity. Preserve unrelated historical installers and private recovery evidence.
3. From a private independent runner, invoke `pnpm install:local:mac --prebuilt --stop-running`.
   Let the installer validate identities, pause the verified services, promote the bundle, roll
   back on installation failure, and restore the original services.
4. Verify installed commit/signature/CLI freshness and both previously loaded services. Run
   `pnpm deploy:relay-worker -- --config <private-config> --verify` for Worker/supervisor health.
5. Reopen the signature-verified installed or rolled-back application, and resume this same task
   if shutdown interrupted it. Read the runner's actual result before reporting success.

## Final status and residual risks

This archive completes source implementation and installation preparation planning. Activation
evidence belongs in the private runner result and final user report; starting the runner alone
does not prove completion. A new owner message in Feishu is required for live acceptance; do not
send unsolicited messages or remove uncertain delivery ledger entries. Existing failed delivery
keys remain fenced and the retained assistant resumes on the next fresh message.

Investigation: [REVIEW_319](../../reviews/recent-3-days/REVIEW_319_feishu-closed-assistant-recovery.md).
