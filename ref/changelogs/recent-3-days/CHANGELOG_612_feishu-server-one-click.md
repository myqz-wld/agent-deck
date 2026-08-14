---
changelog_id: 612
changed_at: 2026-08-14
---

# CHANGELOG_612_feishu-server-one-click: Server-managed Feishu connection

## Summary

Added a server-local, one-command Feishu sidecar lifecycle for both Relay and Full deployments.
The Server Connection Authority now owns connection credentials, pairing, policy, rotation, and
revocation while Worker/Core retains business data and mechanically enforces immutable grants.

## Changes

### Unified Server connection control

- Added the installed `agent-deck-server` CLI with `connections issue|list|verify|revoke|rotate`
  and complete `feishu check|dry-run|connect|status|verify|upgrade|pair|credential|disconnect`
  command families.
- Made Relay and Full use the same server-control contracts while keeping their own authority
  adapters and data ownership.
- Kept `surface` as a Server-assigned channel classification, but resolved Desktop and Feishu to
  the identical explicit `Remote Owner Product v1` grants.
- Removed pre-release topology and credential compatibility: current writers and readers accept
  only canonical `standalone`, `relay`, and `full` values and current schemas.

### Feishu sidecar and product behavior

- Added a root-restricted, mode-0600 local management socket; no management listener is public and
  Feishu app secrets never enter argv, logs, generated credentials, or release bundles.
- Added 192-bit, hash-only, ten-minute, one-time pairing codes followed by explicit local Server
  approval, with expiry, replay, concurrent-claim, tenant/app, and rate-limit fencing.
- Added confirmed p2p session deletion with an exact five-minute session snapshot, stable
  idempotency key, and authoritative Core compare-and-set behavior.
- Made verification prove the exact product/internal claim sets and a live `access_denied` result
  for forbidden `system.health`, instead of trusting advertised metadata alone.

### Reproducible runtime and deployment

- Added digest-pinned amd64 and arm64 Linux runtimes containing Node 22.22.3 ABI 127 and
  `better-sqlite3` 11.10.0, built from architecture-specific pinned base-image digests.
- Added immutable root-owned runtime releases, active/desired pointers, checksum/provenance
  validation, bounded service health checks, credential rotation, rollback, and disconnect cleanup.
- Pruned package source, tests, and native build inputs from runtime archives and reject duplicate,
  traversal, source/test, and secret-like archive entries during build validation.
- Extended Linux install, verification, static checks, manifests, runbooks, and request examples for
  both Relay and Full topologies.

## Validation

- Focused behavior/security suites passed 21 files / 156 tests; expiry/deletion coverage passed 2
  files / 23 tests.
- The complete suite passed 962 files / 6,104 tests; 2 files / 3 tests remained skipped behind
  existing opt-in guards.
- `pnpm typecheck`, `pnpm build`, `pnpm verify:linux-headless`, `pnpm check:deployment`, and the
  Full, Relay, Feishu, and Manager static checks passed.
- Repeated builds were byte-identical: amd64
  `3cdcb188a4e8202bed527d5106aed6d0fe01a4da65f27e52cdc252acfb595f44` and arm64
  `a3eae830abad1105218e901c89a3393454fcd9ed882685ebd550a3472a0849b9`.
- Both artifacts passed inner checksums, pinned Node/ABI checks, and real bundled SQLite execution
  in Ubuntu 24.04 and Rocky Linux 9 containers for their target architectures.
- Review-expiry inventory, changed-source file-size inventory, and `git diff --check` passed. The
  main/preload development restart was not performed after the user asked that existing processes
  not be terminated; no running instance is counted as validation for this branch.

## Do Not Split Protection

No exception is required. All changed production TypeScript/JavaScript and shell source remains
below 500 lines; generated lockfiles are exempt.

## External acceptance boundary

No authorized clean systemd/sshd hosts or tenant-installed Feishu credentials were available.
Real-host service/ownership/forced-command/egress validation and real Feishu message, card,
reconnect, revocation, and load acceptance remain explicit user-environment checks.

## Related records

- `ref/reviews/recent-3-days/REVIEW_247_feishu-server-one-click-acceptance.md`
- `ref/plans/recent-3-days/PLAN_38_feishu-one-click-server.md`
