---
review_id: 281
reviewed_at: 2026-09-28
baseline_commit: 1d2e5d19a3ebd3bccfde87d0d2feffe36dd1b352
expired: false
---

# Relay runtime directory recovery

## Scope

Operational diagnosis and repair of the existing Relay startup failure. The user authorized
restoring the Relay, its local Worker, and its configured Grok Provider supervisor. The hosting
Desktop and installed application are outside the process-mutation scope. No independent review
agents were requested. Review expiry was checked without treating prior coverage as an exemption.

```review-scope
deploy/linux/relay/agent-deck-relay@.container
deploy/linux/relay/preflight.sh
deploy/linux/relay/static-check.sh
src/hosts/instance-manager/instance-reader.ts
src/hosts/instance-manager/lifecycle.ts
src/hosts/instance-manager/runtime-directory.test.ts
scripts/deployment/artifacts.mjs
scripts/deployment/archive-identity.test.mjs
```

## Findings

- HIGH: The Relay unit binds an ephemeral per-instance directory under the service account's
  runtime root, but did not recreate that directory at service startup. Its absence causes Podman
  to exit with status 125 and systemd to retry every five seconds. The official verification and
  a production SSH handshake both fail.
- The instance manager treated missing ephemeral runtime state as invalid durable state, so the
  supported inspection and startup path could not repair the missing directory before upgrade.
- The local Worker and Grok Provider supervisor are not loaded. The installed Worker passes its
  configuration, runtime-module, and SQLite ABI checks; its previous dependency-loading defect
  is not reproduced by the current installation.
- Release inspection found local owner/group names in all 54 outer tar headers. No local home or
  checkout path appeared in the distributed payloads. Archive ownership must be normalized before
  transferring the repair; existing remote copies and published history are outside this finding.

## Fixes

- Declare both the Relay runtime namespace and instance directory with mode 0700. Preserve the
  directories across service stops so the instance manager can inspect and fence stopped units.
  systemd recreates them during startup after runtime storage is cleared. The behavior follows
  the [systemd execution contract](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).
- Allow read-only inspection when Relay runtime directories are absent. Existing directories
  retain canonical-path, ownership, and mode checks; durable artifacts remain mandatory.
- Recreate only the exact runtime directory during authorized startup, after image and acceptance
  evidence checks. Stop an exact unit that is retrying before creating its mount source, preventing
  automatic startup from racing the preflight. Reject an already-active Relay with missing runtime
  state. Revalidate the durable artifacts before creating directories.
- Extend the strict Quadlet directive audit and tamper fixtures. Recorded releases without the new
  directives remain usable for recovery and generation rollback; newly shipped templates must
  include all directory-management settings.
- Normalize release, evidence, and credential archive owner/group metadata to numeric root IDs
  and generic names using the native BSD/GNU tar flags. Validate every produced tar header.

## Validation

- Focused instance-manager and deployment suite: 23 files, 193 tests passed, including 10 new
  regressions for missing directories, read-only inspection, exact retry shutdown, stale evidence,
  active-service anomalies, symlinks, and owner/mode rejection.
- `pnpm typecheck` passed, including architecture checks.
- `pnpm test`: 1,038 files and 6,452 tests passed; two files and three tests retain existing skips.
- Relay static verification and deployment automation checks passed.
- The headless build passed reproducibility and isolated Worker entrypoint validation.
- Both Feishu runtime architectures built successfully; complete headless packaging checks passed.
- After archive normalization, all 30 deployment tests passed. The inspected release has 54 outer
  members; outer and nested tar metadata contain no personal ownership, and payloads contain no
  local home or checkout paths. Native runtime and SQLite binaries were included in this scan.
- Changed source files are below 500 lines. `git diff --check` passed.

## Live acceptance

Source validation is complete. The exact validated release must be committed and pushed before
official server check, dry-run, upgrade, and verify. Runtime restoration and subsequent SSH/Core
acceptance are tracked in the active recovery plan; they are not claimed by this source record.

## Residual risk

The repair does not delete or replace durable instance state, credentials, or Workspace data.
Fresh service startup is required to confirm the deployed unit and Worker are operational.
The live recovery must preserve the currently hosting Desktop.
