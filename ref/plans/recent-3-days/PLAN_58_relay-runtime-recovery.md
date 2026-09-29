---
plan_id: PLAN_58
title: Relay runtime recovery
status: completed
created_at: 2026-09-28
updated_at: 2026-09-28
completed_at: 2026-09-28
base_commit: 1d2e5d19a3ebd3bccfde87d0d2feffe36dd1b352
deployed_release: git-54a19a9de6a5
related_review: REVIEW_281
---

# Relay runtime recovery

## Goal and authorization

Restore the existing Relay, its configured Worker, and its Grok Provider supervisor after the user
authorized recovery. Preserve the hosting Desktop, installed application, credentials, Workspace,
and unrelated services. Use the official deployment entrypoints and exact managed instance.

## Completed work

1. Diagnosed a missing ephemeral mount directory that made Relay exit repeatedly with status 125.
2. Added systemd runtime-directory creation/preservation and an exact, evidence-gated manager
   recovery path. Kept read-only inspection free of filesystem repair.
3. Added directory-loss, retry-loop, and tamper regressions. Normalized archive ownership after
   package inspection exposed local owner/group metadata.
4. Passed typechecking, 6,452 full-suite tests with three existing skips, 193 focused tests, and
   30 deployment tests after the archive change. Headless reproducibility, isolated Worker startup,
   both Feishu architecture builds, and package inspection passed.
5. Committed and pushed the exact source release; completed Relay check, dry-run, upgrade, and
   verify through `pnpm deploy:relay-server`.
6. Completed Worker check, dry-run, upgrade, and verify through `pnpm deploy:relay-worker`.
7. Verified real SSH connections, Core session listing, creation descriptors for all three adapters,
   and repeated disconnect/reconnect. Final official verification passes for both Relay and Worker.

## Final status and limits

Relay is healthy with zero restarts after upgrade. Worker and supervisor are running, with all
supervisor checks passing. Runtime directories have the expected service ownership and mode 0700.
The hosting application was not restarted or replaced.

Seven follow-up connection/read cycles completed, including one automatic SSH retry. The intermittent
bridge rejection was not attributed to a precise cause. No provider inference session or actual host
reboot was exercised. The full evidence and residual limits are in
[REVIEW_281](../../reviews/recent-3-days/REVIEW_281_relay-runtime-directory-recovery.md).
