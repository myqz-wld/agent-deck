---
plan_id: PLAN_59
title: Relay handshake investigation
status: completed
created_at: 2026-09-28
updated_at: 2026-09-29
completed_at: 2026-09-29
base_commit: e3bdf2b4738168b587a09b30b3e585309a7fd472
validated_source: b9ee1bd71af44e3b90aab5d94dece332a1f33daf
deployed_release: git-b9ee1bd71af4
installed_worker_commit: 001a044ee1ea7491385e1e15b049eeb65c96e3ae
related_review: REVIEW_282
---

# Relay handshake investigation

## Goal and scope

Diagnose intermittent Relay handshakes after runtime recovery, repair confirmed defects, and
validate the actual deployment boundary. The user authorized recovery of the existing Relay,
Worker, and Provider supervisor, then cleanup of old server logs and disposable caches. Preserve
credentials, runtime data, current/rollback images, and the hosting Desktop application.

## Completed work

1. Reproduced three no-retry handshake failures in sixteen connections. A separate held-client
   probe showed that closing one connection could retire the shared Worker attachment.
2. Fixed symmetric late-frame handling in Relay and Worker. Eight regressions failed before the
   repair; all eight and six identity-boundary regressions passed afterward.
3. Validated exact source `b9ee1bd7` in an isolated worktree: typecheck, 6,467 tests with three
   existing skips, Linux headless checks, both Feishu builds, and macOS packaging passed.
4. Inspected the packaged Worker, mounted DMG, release archives, native payloads, and ownership
   metadata. Preserved the validated DMG outside the worktree before cleanup.
5. Diagnosed Podman image-layer commit failures alongside 97% root-disk usage. Cleared archived
   system journals, downloaded package cache, and regenerable package indexes. Active logs,
   installed packages, release verification metadata, and runtime data remain intact.
6. Completed official Relay check, dry-run, upgrade, and verify. Generation 20 runs the repaired
   server; `git-54a19a9de6a5` remains the rollback release. Final disk usage is 89%, with about
   816 MiB available after the upgrade. Worker and Provider supervisor verification passes.
7. Merged and pushed the repair and records to `main`, removed the isolated worktree and both
   temporary branch refs, and preserved unrelated work. The user subsequently reinstalled the app.
8. Verified the newly installed Worker includes the repair and is running. Completed 33 live
   connection/read/close cycles with retries disabled, including 23 held-client isolation cycles,
   with zero failures, no SSH attachment replacement, and no new Worker log output.
9. Found and atomically refreshed an expired Worker-local Grok credential copy using the supported
   credential installation command. All three adapters were available afterward. Recorded a separate
   follow-up for automatic synchronization and deployed-copy health verification.

## Final acceptance and limits

The earlier server-only rollout failed the held-client probe on cycle two while the old Worker
was still installed. After the user installed clean build `001a044e`, the scoped source files were
confirmed unchanged from the validated repair and both endpoints passed live acceptance. The
Worker, supervisor, and Worker SSH child kept their process identities throughout the recheck,
including the credential refresh. No application or service restart was needed for this check.

The original handshake repair and rollout are complete. The source credential can refresh while
its private Worker projection expires; the official health check did not distinguish that state.
Follow-up issue `611fdd74-7a9f-4f61-af96-d85961696739` tracks synchronization, deployed-copy
validation, and accurate availability reasons. The one-time credential refresh here does not
provide automatic renewal.

Provider model turns and a host reboot remain outside the completed acceptance. Full evidence is in
[REVIEW_282](../../reviews/recent-3-days/REVIEW_282_relay-stream-retirement-isolation.md).

## Evidence and cleanup

- The original prepared DMG was superseded by the user-installed build; its validation and checksum
  remain recorded in REVIEW_282, and its old retained path is no longer present.
- The temporary live-probe runner and TypeScript input remain intentionally non-final for the
  credential follow-up, which the user requested implementing immediately after acceptance.
- The private journal backup stays outside the repository under `$HOME/.agent-deck/diagnostics`;
  its adjacent `metadata.json` records the verified checksum and location. The duplicate scratch
  index was removed after confirming it matched this original metadata.

These local artifacts are not distribution inputs. Unrelated work in the main checkout is outside
this merge and must remain untouched.
