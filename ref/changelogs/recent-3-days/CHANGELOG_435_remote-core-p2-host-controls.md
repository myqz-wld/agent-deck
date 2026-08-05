---
changelog_id: 434
changed_at: 2026-08-04
---

# CHANGELOG_435_remote-core-p2-host-controls: Add bounded remote host controls

## Summary

Agent Deck now has two additional host-side implementation layers: a transport-neutral Feishu
session console and an exact, host-only Linux instance lifecycle manager. Both layers are isolated
behind injected ports and fail-closed policy. They are foundations for later production composition,
not a claim that remote deployment is ready for end users.

## Feishu session console

- Added exact app, tenant, open-id, instance, credential, and chat binding with owner-equivalent
  enrollment and independent per-chat selection, subscription, client, cursor, and delivery state.
- Added bounded commands for listing, selecting, creating, reading, sending, runtime control,
  subscription control, and authoritative still-pending approval actions. Approval presentation is
  30 minutes by default, while Core pending state remains authoritative.
- Added immutable HostHello validation, method/capability enforcement, per-chat client generations,
  synchronous replay admission, monotonic cursors, slow-chat isolation, and deterministic retirement
  and shutdown barriers.
- Added crash-recoverable delivery phases with event-derived idempotency, attempt fencing, explicit
  ambiguous-transport reconciliation, exact metadata validation, output redaction, and no persisted
  message, history, approval, diff, blob, or card body.
- Bounded active and inactive subscription metadata together, fenced contradictory delivery claims,
  and removed a notification-lane self-retirement wait during credential revocation.

## Linux instance lifecycle

- Added non-mutating plans plus create, list, start, stop, status, upgrade, rollback, and explicitly
  confirmed removal for exact per-instance Full and Relay namespaces.
- Added digest-pinned images, canonical checksummed records and version artifacts, non-expiring exact
  host locks, operation journals, generation/version fences, atomic cutover, health gates, rollback,
  and phase-aware crash recovery.
- Added descriptor-oriented exact-tree capture/removal ports, symlink and identity rechecks, trusted
  artifact hashes, root-owned egress/quota evidence binding, resource ceilings, and cleanup failure
  aggregation.
- Kept the manager host-only and unreachable from Core, sessions, SSH, Feishu, appliance containers,
  and agent-visible container-engine access.

## Compatibility and remaining gates

- The existing Standalone desktop behavior is unchanged.
- Feishu uses only injected Core, transport, nonce, clock, audit, observer, project-authority, and
  metadata-store ports. A real Feishu long-connection adapter and production composition remain
  future work.
- Relay commands that would expose a Worker cwd remain unavailable until shared contracts provide
  bounded cwd-free session projections, opaque project list/resolve, and create-by-project-reference.
- The Linux manager still requires production no-follow filesystem, process-death host-lock,
  trusted-command, systemd, Podman, and root-owned evidence adapters plus real Ubuntu 24.04 and EL9
  acceptance.

## Validation

- P2 focused matrix: 22 files / 200 tests passed after Lead audit corrections.
- Architecture boundaries and both Node and web TypeScript projects passed.
- Full Electron-ABI suite: 543 files / 4,382 tests passed; one opt-in live smoke skipped.
- Production Electron build passed.
- Linux manager exact-template/static policy checks, shell syntax checks, production file-size checks,
  and whitespace checks passed.
- Real Feishu, systemd, Podman, SELinux/AppArmor, quota, egress, SSH, and Linux platform acceptance
  were not run and are not claimed.

## Post-main integration

- Committed the P2 implementation as `ff68d539e7e52c9e592e8c6d44c11640a773e12a`.
- Fetched and merged then-current `origin/main` at
  `465446c4988a30eb7ddd6e81562ea28a990e5b2b`; the conflict-free merge commit is
  `2abd3f7534d8ed0c51f0c2cd8d00387ae2710f77`.
- Re-ran `pnpm typecheck`, the complete P2 focused matrix, `pnpm test`, `pnpm build`, Full appliance
  preflight, Relay exact-template/tamper checks, manager static policy, shell syntax, file-size, and
  whitespace gates after the merge. All required gates passed with the single documented opt-in
  smoke skip.

## Do Not Split Protection

Delivery generation, cursor advancement, lane retirement, credential revalidation, and persistent
attempt phases form one replay-safety chain. Instance locks, journals, exact identities, evidence,
health gates, and destructive confirmation form one host-mutation safety chain. Do not weaken or
land only part of either chain without revalidating its full lifecycle and crash boundaries.
