---
plan_id: 84
title: Provider runtime refresh and local installation recovery
status: execution-handoff
created_at: 2026-10-11
completed_at: 2026-10-12
base_commit: dad1f36538b44362ad17d8d0f0897912949a8e8e
related_review: REVIEW_318
related_changelog: CHANGELOG_675
---

# Provider runtime refresh and local installation recovery

## Goal and constraints

Update the scoped Claude, Codex, Grok, ACP, and MCP packages; prepare a verified macOS application;
and repair local installation so managed KeepAlive services cannot race bundle replacement.
Preserve the user's external Grok executable and override, service definitions, credentials, other
applications, retained historical installers, and concurrent Browser/README changes.

The user authorized commit/push and packaging/installation, then explicitly approved stopping the
exact installed application, hosted sessions, and two managed background processes and reopening
the application afterward. Reverify current identities before any action; retain the PID, start-time,
and executable checks. No process-wide kills or global application-registration resets.

## Completed preparation

1. Updated Claude Agent SDK to 0.3.296 (Claude Code 2.1.296), Anthropic SDK to 0.133.0, Codex to
   0.162.1, Grok to 1.0.50, ACP to 1.8.0, and MCP to 1.32.1. Committed and pushed as `dad1f365`.
2. Handled ACP's capability-gated child-session updates without attributing them to the parent
   transcript. Validated real isolated Codex/Grok initialization, package versions, and native
   application/Worker executables.
3. Diagnosed installation failures: launchd KeepAlive respawned processes after process-only
   shutdown, while failed preparation left temporary application copies registered by macOS.
4. Added trusted loaded-service discovery, consumer-first pause and provider-first restore, bounded
   native unload completion, transactional promotion/rollback, and temporary-copy cleanup.
5. Preserved recovery backups on uncertain failure. Retained the original installed application
   after the unsuccessful attempts and restored both original managed services with health checks.
6. Validated the final source with 38 focused tests, typechecking, 7,108 passing full-suite tests
   (six opt-in skips), and real immediate/delayed KeepAlive service fixtures. SQLite remained intact.

## Installation evidence and lesson

The first provider-package install aborted before replacement when KeepAlive generated new PIDs.
The `c58694ba` attempt exposed asynchronous `bootout`: a job remained registered as `SIGTERMed`
after success was returned. The final source now waits for confirmed disappearance before replacing
the application or starting restoration. The delayed native fixture reproduced the timing and
passed the corrected lifecycle, including idempotent restore and bounded failure recovery.

The prepared `c58694ba` artifact passed native versions, Worker sandbox checks, all 15,298 archive
members, privacy scans of 273 physical files, and DMG integrity. A subsequent source commit requires
a clean rebuild before `--prebuilt`; do not reuse that superseded package as the final release.

## Final execution handoff

This archive completes implementation planning and source validation, not installed activation.
The remaining authorized execution must:

1. Commit/push the delayed-unload correction and rebuild a clean matching macOS package.
2. Verify its metadata, native versions, Worker sandbox, archive privacy, DMG, and SQLite binding.
3. Run `pnpm install:local:mac --prebuilt --stop-running` from an independent runner after warning
   that hosted sessions may be interrupted. Use the existing exact shutdown/install authorization.
4. Verify installed signature/commit/CLI freshness, both previously loaded service definitions and
   running states, Provider supervisor health, Worker status, and disposal of generated/staging/backup
   copies. Remove only their exact stale LaunchServices registrations.
5. Reopen the signature-verified installed or rolled-back application on both success and failure.
   Continue this existing session only if it was interrupted. Consume the actual result before
   reporting completion; a launched runner is not proof of installed success.

The private runner writes `install-result.json` and `install.log` outside version control and
distribution inputs. Preserve failed-attempt evidence separately from the final result. Machine
activation is recorded by the runner and final user report, not inferred from this preparation plan.

Evidence: [dependency refresh](../../changelogs/recent-week/CHANGELOG_675_provider-runtime-latest-refresh.md)
and [installer investigation](../../reviews/recent-3-days/REVIEW_318_macos-installer-managed-services.md).
