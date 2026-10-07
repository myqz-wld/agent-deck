---
review_id: 281
reviewed_at: 2026-09-28
baseline_commit: 54a19a9de6a58a0932d8505fdf1f38f6d5f16355
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

- Committed and pushed release `git-54a19a9de6a5`, then completed official Relay `--check`,
  `--dry-run`, `--upgrade`, and `--verify`. Final verification reports a healthy container and ready
  Feishu runtime files. The Feishu active-runtime pointer is preserved by the deployment workflow.
- The deployed unit is active/running, has zero restarts, and exposes the intended runtime
  directory settings. Both namespace and instance directories are service-owned with mode 0700.
- Completed official Worker `--check`, `--dry-run`, `--upgrade`, and `--verify`. Worker is running;
  supervisor configuration, credential validation, and service health all pass. Both LaunchAgents
  have run once without an exit; the previous Worker error log has not grown.
- The production SSH client connects to the Relay and reaches a `local-worker` Core at generation
  1. `session.console.list` and `session.console.capabilities` complete successfully. Claude,
  Codex, and Grok appear enabled in the returned creation descriptors.
- An early single-attempt reconnect failed with a generic SSH bridge error. Seven subsequent
  connect/read/close cycles all completed; six connected directly and one recovered through the
  client's automatic retry. Final official Relay and Worker verification still pass.
- The hosting Desktop and installed application were preserved. No credentials were rotated and
  no new model sessions were created during acceptance.

Completed plan: [Relay runtime recovery](../../plans/recent-month/PLAN_58_relay-runtime-recovery.md).

## Residual risk

The runtime-directory outage is repaired and live service recovery is complete. Intermittent SSH
bridge rejection was observed and automatically recovered, but its precise cause was not established
by this pass. Acceptance covers transport, read requests, and creation descriptors; it does not claim
a provider inference round trip or an actual host reboot test. Durable instance state, credentials,
Workspace data, and the hosting Desktop remain intact.
