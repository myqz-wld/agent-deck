---
changelog_id: 434
changed_at: 2026-08-04
---

# CHANGELOG_434_remote-core-p1-foundations: Establish remote Core P1 foundations

## Summary

Agent Deck now has the first host-neutral implementation layer for three explicit topologies:
Standalone, a Linux-hosted Server Core, and a lightweight Relay backed by one local Worker. This
stage establishes contracts, transports, lifecycle boundaries, and fail-closed deployment policy;
it does not yet advertise remote deployment as a supported end-user workflow.

## Daemon and composition boundaries

- Added an Electron-free daemon host over a private Unix socket with injected Core execution,
  typed protocol negotiation, immutable transport-created access context, bounded per-connection
  scheduling and output, cancellation, and deterministic lifecycle teardown.
- Added shared composition lifecycle control for Standalone, Server Core, Relay server, and local
  Worker roots, including ordered startup, reverse shutdown, and rollback of partial startup.
- Added restricted SSH bridge admission and stdio tunnelling without an interactive shell, PTY,
  forwarding, public Agent Deck port, or client-controlled identity.
- Added typed `cancelled` and redacted `internal_error` client outcomes.

## SSH desktop host

- Added an Electron-main-owned SSH `AgentDeckClient` with pinned host keys, one explicit identity,
  strict OpenSSH options, bounded framing, reconnect/replay, deadlines, cancellation, and awaited
  child retirement.
- Added topology-aware Electron host profiles and connection registry state with generation-
  qualified Relay identities, lifecycle race fencing, immutable observer snapshots, and a renderer-
  safe profile projection that excludes key paths and raw transports.

## Relay and local Worker

- Added neutral Relay wire contracts, route flow control, bounded queues, client isolation, one
  authoritative Worker generation, takeover fencing, live credential revocation checks, and an
  outbound-only Worker OpenSSH attachment.
- Added a private Relay control-socket host that routes opaque Core frames between multiple clients
  and the active Worker without interpreting or persisting business content.
- Restricted Relay metadata to exact access, routing, Worker, Feishu context/subscription/delivery,
  and health allowlists; session messages, history, approvals, diffs, blobs, repositories,
  providers, Browser state, and business SQLite remain forbidden.

## Linux appliance policy

- Added parameterized rootless Podman/Quadlet foundations for full Server Core and relay-only
  instances with read-only roots, dropped capabilities, no-new-privileges, scoped per-instance
  volumes, resource limits, and no published control port or container-engine socket.
- Added fail-closed preflight and manifest policy checks. Public-only egress, quota, SELinux,
  systemd, rootless Podman, native Node ABI, and nested-provider sandbox claims still require
  per-instance evidence on Ubuntu 24.04 and EL9.

## Compatibility and delivery boundary

- Preserved the existing Standalone desktop and preload surface while remote-capable APIs migrate
  in vertical slices.
- Merged then-current `origin/main` at `a185efc9` after the P1 implementation commit `5602c7f1`;
  the merge completed without conflicts and retained both change sets.
- Feishu, renderer migration, real Linux packaging/entrypoints, native SSH/Podman validation,
  durable Core replay/idempotency implementation, and full provider/Browser extraction remain
  subsequent gated work.

## Validation

- Post-merge architecture and dual TypeScript checks passed.
- P1 focused matrix: 51 files / 311 tests passed.
- Full Electron-ABI suite: 520 files / 4,177 tests passed; one opt-in live smoke skipped.
- Production Electron build passed.
- Full-appliance template preflight, Relay exact-template and tamper checks, shell syntax checks,
  production file-size checks, and `git diff --check` passed.

## Do Not Split Protection

Admission identity, bounded transport lifecycle, Worker generation fencing, opaque Relay routing,
and the appliance ceiling form one security chain. Do not weaken or land only one layer without
revalidating the complete client-to-authoritative-Core path.
