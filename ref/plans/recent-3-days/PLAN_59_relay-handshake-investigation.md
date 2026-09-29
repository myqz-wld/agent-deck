---
plan_id: PLAN_59
title: Relay handshake investigation
status: handed-off-with-worker-rollout-pending
created_at: 2026-09-28
updated_at: 2026-09-28
completed_at: 2026-09-28
base_commit: e3bdf2b4738168b587a09b30b3e585309a7fd472
validated_source: b9ee1bd71af44e3b90aab5d94dece332a1f33daf
deployed_release: git-b9ee1bd71af4
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

## Validation boundary and remaining work

The installed Worker remains on the old packaged runtime. With only the Relay endpoint updated,
the held-client probe failed on its second cycle and the Worker SSH child reconnected. Production
churn testing stopped at that failure. This is consistent with the Worker regression; no new
Worker stderr entries captured a live frame trace. The handshake issue is not fully accepted.

The user redirected the final step to merge the work into `main`, then remove the worktree and
branch. This handoff closes the isolated investigation without claiming that Worker rollout is
complete. A later installation must verify the current app version and exact process identities,
obtain explicit approval under Host Runtime Safety before stopping/replacing/relaunching the
hosting application, and restore the exact managed Worker and supervisor through supported
lifecycle entrypoints. KeepAlive services must be stopped before replacing their shared bundle.

After both endpoints are updated, repeat no-retry handshakes and keep an independent connection
online during connection churn. Provider model turns and a host reboot remain outside the
completed acceptance. Full evidence is in
[REVIEW_282](../../reviews/recent-3-days/REVIEW_282_relay-stream-retirement-isolation.md).

## Preserved local materials

- Validated DMG: `.ref/artifacts/relay-stream-retirement-b9ee1bd7/Agent Deck-0.1.0-arm64.dmg`.
  SHA-256: `59ecf51501a5665f5596b4203fe8ba8d1bf1e51b25f6a1cea3fd806f9774f493`.
- Probe: `node .ref/reviews/run-relay-live-check.mjs --isolation --count 8`, with its TypeScript
  input alongside it. These local diagnostics remain intentionally non-final until acceptance.
- The private journal backup stays outside the repository under `$HOME/.agent-deck/diagnostics`;
  `.ref/reviews/relay-journal-backup.json` records its verified checksum and location.

These local artifacts are not distribution inputs. Unrelated work in the main checkout is outside
this merge and must remain untouched.
