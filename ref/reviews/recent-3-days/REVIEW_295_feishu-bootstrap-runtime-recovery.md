---
review_id: 295
reviewed_at: 2026-09-29
baseline_commit: f034ab2a97b77bb07dcb32f5523c86aae4ac8006
expired: false
---

# Feishu bootstrap runtime recovery

## Scope and method

Live connection diagnosis, complete changed-scope inspection and targeted lifecycle regressions.
Diagnostics and credentials remained private; no Desktop replacement or independent agents were used.

```review-scope
src/gateways/feishu/sqlite-bootstrap-retry.ts
src/gateways/feishu/sqlite-store.ts
src/gateways/feishu/sqlite-store.test.ts
src/hosts/server-control/feishu-connect-runtime.ts
src/hosts/server-control/feishu-control-service.ts
src/hosts/server-control/feishu-control-service.test.ts
deploy/linux/feishu/README.md
```

## Findings

- HIGH: A fresh Feishu connection continued to use the previously active runtime after a server
  release installed a newer desired runtime. The old runtime used protocol 2.7 while Core required
  2.8. Feishu WebSocket and SSH public-key authentication succeeded, but Core rejected the handshake.
  Runtime upgrade required existing connection files, which connect rollback had removed.
- MEDIUM: The failed connection left one active, unpaired local credential in SQLite. A retry with
  a fresh server credential then failed startup because reconciliation required identity rotation
  even though no owner, pairing request, pairing code, delivery or chat metadata existed.

## Fixes landed

- Fresh inactive connections atomically select the installed desired runtime, verify its native
  ABI, and enroll/start/verify through the existing transaction. A failed activation or connection
  restores the previous runtime pointer. Established connections retain explicit upgrades, and an
  active service without a matching authority record is preserved and rejected.
- An empty unpaired bootstrap may retry with a new credential. Existing local public history is
  revoked and preserved while the fresh credential is inserted within the existing SQLite
  transaction. Any owner history or pairing/user metadata retains the explicit-rotation requirement.
- Separate helpers keep both existing source modules below 500 lines. No schema migration or
  direct production database rewrite is needed.

## Validation and evidence

- Current production client/Core probe passed in about one second. An isolated probe using the
  installed old runtime's actual client/probe code reproduced `incompatible_protocol` with client
  2.7 and host 2.8. Temporary credentials were issued/revoked through the official Server CLI;
  every probe credential was revoked and its remote files removed. No session/chat was created.
- Read-only production SQLite inspection found one unpaired active credential and one health row;
  every pairing, context, subscription, delivery, cursor and deletion-confirmation table was empty.
- Tests cover retained revocation history, rejected pending-pairing replacement, preserved owner
  identity, desired-runtime selection, native ABI failure, connection rollback, established-runtime
  preservation, and preservation of an unmatched active service.
- Typecheck, 6,635 full-suite tests, Linux headless build/reproducibility, both Feishu runtime builds,
  headless packaging checks and all lifecycle static gates passed. Three existing tests are skipped.
- Generated bundles, actual runtime archive contents and source passed privacy inspection. Legacy
  review-expiry metadata is not treated as an exemption; the complete changed scope was inspected.

## Residual risk and follow-ups

This source checkpoint still requires server activation and real Feishu acceptance. Relay itself
is healthy at generation 22, and the Feishu sidecar is inactive after safe rollback. Event/callback
subscription, publication, owner pairing and an actual provider reply remain in the active plan.
