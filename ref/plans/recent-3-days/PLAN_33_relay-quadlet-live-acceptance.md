---
plan_id: PLAN_33
title: AWS rootless Podman Relay with isolated macOS Worker
status: completed
created_at: 2026-08-09
updated_at: 2026-08-09
completed_at: 2026-08-09
base_branch: main
base_commit: e8a71b83bb4e43eaaf088476f232b3e970cec915
accepted_source_commit: 923b2e820cb1ca62c3f3b7113e1a7642a9727c61
related_changelog: CHANGELOG_580, CHANGELOG_581, CHANGELOG_582
related_review: REVIEW_219, REVIEW_220, REVIEW_221
---

# AWS rootless Podman Relay with isolated macOS Worker

## Goal

Migrate `aws-relay-with-mac-worker` on `35.166.66.245` from the direct user service to a
digest-pinned rootless Podman Quadlet, keep `mac-worker-for-aws-relay` on the Mac, and bind it to the
dedicated mode-0700 Workspace
`/Users/wanglidong/AgentDeckWorkspaces/aws-relay-with-mac-worker`.

## Invariants

- Fix and commit every confirmed source issue before deploying that fix.
- Keep the old Relay available for automatic rollback until the new container is healthy.
- Preserve the existing instance, Worker, credentials, SSH forced commands, and metadata.
- Publish no container port and mount no engine socket.
- Keep Relay metadata under a real 1 GiB filesystem ceiling and deny private/link-local/metadata
  egress for the rootless service UID.
- Do not install Podman on the Mac while Docker/Colima already supplies its required OCI runtime.
- Remove the prior relay-smoke instance and all superseded production artifacts after acceptance.

## Decisions

- AWS owns rootless Podman 4.9.3 and the Relay container. macOS continues to use Docker 29.7.2 on
  Colima; Podman is not installed locally.
- The production image is pinned to
  `localhost/agent-deck-relay@sha256:33138e8ab0549f1df7801a834869f148a8d5275b0c56b239ccd9bbb06a680be2`.
- Podman 4.9 generates `--sdnotify=conmon` for `Notify=healthy`, so systemd activation retains the
  committed host-side health gate. Runtime preflight also proves the user-systemd health timer with
  a real canary.
- The state path is a sparse ext4 loop-backed mount with `nosuid,nodev,noexec,noatime` and a one-GiB
  block-device ceiling.

## Issues fixed before deployment

| Commit | Finding | Resolution |
|---|---|---|
| `606cac90` | Podman 4.9 could mark the generated service started before container health. | Added a bounded root-owned `ExecStartPost` health gate. |
| `9be61c32` | Preflight did not prove Podman's separate user-systemd health scheduler. | Added a real 20-second health-scheduler canary. |
| `74eca255` | The selected Node base lacked the wrapper-required regular `/usr/bin/node`. | Materialized and verified the exact Node path and made probes execute it directly. |
| `923b2e82` | Quadlets used Dockerfile-style `["CMD", ...]` health argv, which Podman tried to execute literally. | Switched Relay and Full templates to executable-first Podman JSON argv. |

The first two live attempts were contained by the rollback fence: one failed before serving because
of the Node path, and one created its socket but was killed by the invalid health argv. In both
cases the new service was stopped and the old healthy Relay was restored before continuing.

## Final deployment

- Quadlet service: `agent-deck-relay@aws-relay-with-mac-worker.service`
- Container: `agent-deck-relay-aws-relay-with-mac-worker`
- Config:
  `/home/ubuntu/.config/agent-deck-relay/aws-relay-with-mac-worker/config.json`
- State:
  `/home/ubuntu/.local/share/agent-deck-relay/aws-relay-with-mac-worker`
- Control socket:
  `/run/user/1000/agent-deck-relay/aws-relay-with-mac-worker/control.sock`
- Host health gate: `/opt/agent-deck/bin/agent-deck-relay-health-gate`
- Public-only egress and quota evidence:
  `/etc/agent-deck-relay/evidence/aws-relay-with-mac-worker`

## Acceptance evidence

- Complete runtime preflight passed exact template, rootless identity, fixed Podman/Node paths,
  keep-id mounts, read-only config, health scheduling, egress evidence, and quota evidence.
- The live container is `running/healthy`, uses UID/GID 1000, a read-only root filesystem,
  no-new-privileges, all capability drops, no published ports, and limits of 512 MiB, one CPU, 256
  PIDs, and 4,096 file descriptors.
- The control socket is mode 0600. Its three mounts are the read-only config plus exact state and
  runtime directories.
- A controlled Quadlet restart changed the container ID, returned healthy, and automatically
  restored the Worker to `online` generation 1.
- A client credential passed strict host-key verification and held a `desktop-full` bridge for five
  seconds through an ephemeral ssh-agent.
- The Mac LaunchAgent is running as PID 61001 with the dedicated Workspace as its actual cwd.
- User linger is enabled; the generated default-target dependency, ext4 fstab mount, and enabled
  rootless-egress service are present. No reboot was required or performed.
- AWS user and system managers report zero failed units. Rootful Podman API service/socket remain
  inactive.
- Repository validation passed typecheck, 860 test files / 5,612 tests, production build, Linux
  headless verification, Relay/manager/Full static checks, and `git diff --check`.

## Cleanup

- Removed the old relay-smoke service, configuration, state, staging, and SSH authorization lines.
- Removed the superseded direct production user service, its old config/state copies, old image,
  dangling image, remote staging directories, and local render staging.
- Kept only the active Relay image plus its pinned Node base.
- The old service now resolves as `not-found`; the active data and credentials were not removed.

## Residual boundaries

- Full appliance received the same health-argv source correction but was not deployed or accepted on
  a real Full host in this task.
- macOS Podman remains intentionally absent because the Worker already has the supported
  Docker/Colima runtime.

## Final status

Completed. The AWS Relay is rootless, digest-pinned, health-gated, quota-bound, public-egress-only,
and connected to the isolated Mac Worker Workspace.
