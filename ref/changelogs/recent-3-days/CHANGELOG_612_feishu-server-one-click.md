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
- Split Relay's immutable schema-v2 runtime config from its mutable credential authority. The
  service mounts the exact per-instance config directory read-only, polls a separate mode-0600
  `authority.json`, and observes atomic Server CLI issue/revoke changes without a restart.
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
- Made runtime packaging reproducible across independent processes, raised the bounded release-upload
  timeout for slow links, and reduced installer peak disk use by extracting and validating the
  runtime in its final filesystem before the atomic cutover.
- Pruned package source, tests, and native build inputs from runtime archives and reject duplicate,
  traversal, source/test, and secret-like archive entries during build validation.
- Extended Linux install, verification, static checks, manifests, runbooks, and request examples for
  both Relay and Full topologies.

## Validation

- Focused behavior/security suites passed 21 files / 156 tests; expiry/deletion coverage passed 2
  files / 23 tests.
- The complete suite passed 963 files / 6,110 tests; 2 files / 3 tests remained skipped behind
  existing opt-in guards.
- `pnpm typecheck`, `pnpm build`, `pnpm verify:linux-headless`, `pnpm check:deployment`, and the
  Full, Relay, Feishu, and Manager static checks passed.
- Repeated independent-process builds were byte-identical: amd64
  `f1a5392b0635a47b08cb9e1b066f38302ad9c8192e170029182338e813777d52` and arm64
  `59bc3544f016c2b920e1b956c84e731eedec98e8778b3a42f97df27cfd72d2af`.
- Both artifacts passed inner checksums, pinned Node/ABI checks, and real bundled SQLite execution
  in Ubuntu 24.04 and Rocky Linux 9 containers for their target architectures.
- Review-expiry inventory, changed-source file-size inventory, and `git diff --check` passed. The
  main/preload development restart was not performed after the user asked that existing processes
  not be terminated; no running instance is counted as validation for this branch.

## Do Not Split Protection

No exception is required. All changed production TypeScript/JavaScript and shell source remains
below 500 lines; generated lockfiles are exempt.

## Relay live acceptance and external boundary

- An authorized ARM64 Ubuntu Relay host passed the official check/dry-run/verify flow and the
  one-way pre-release clean break to generation 15 (`git-4fd970044463`). The installed schema-v2
  config and unit match the manager record, the separate credential authority is healthy, and the
  transition journal is clear. Relay remained healthy while its Worker route was offline; no local
  process was terminated.
- The installed server CLI passed `connections verify|list`, disposable credential lifecycle
  acceptance, live authority projection without a Relay restart, and `feishu check|status`. The
  Feishu runtime is installed and verified, while the service correctly remains inactive without
  app credentials.
- No authorized Full host, EL9-family systemd host, or tenant-installed Feishu app credentials were
  available. Full live deployment and real Feishu message/card/pair/delete/reconnect/revocation/load
  acceptance remain explicit external checks.

## Related records

- `ref/reviews/recent-3-days/REVIEW_247_feishu-server-one-click-acceptance.md`
- `ref/reviews/recent-3-days/REVIEW_248_feishu-relay-live-acceptance.md`
- `ref/plans/recent-3-days/PLAN_38_feishu-one-click-server.md`
