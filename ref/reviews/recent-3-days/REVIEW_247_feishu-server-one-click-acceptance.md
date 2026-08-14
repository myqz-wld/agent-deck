---
review_id: 247
reviewed_at: 2026-08-14
baseline_commit: bdc7bdb3b12694a95506b3f670dcc28287d21cfd
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record and index maintenance is mechanical evidence derived from the reviewed tree."
---

# REVIEW_247_feishu-server-one-click-acceptance: Feishu server integration

## Scope and method

The review began with the repository review-expiry inventory and examined the complete feature diff
from the pre-release compatibility-cleanup baseline through implementation commit
`09c7676bd6095411177dd49664c678d77b6ae538`. It traced credential issuance and revocation, Relay and
Full admission, immutable grant claims, sidecar secret boundaries, local management transport,
pairing races, destructive confirmation, runtime provenance, install/upgrade/rollback, and service
recovery. Local/container evidence is separated from unavailable real-host and real-tenant evidence.

```review-scope
deploy/linux/feishu/README.md
deploy/linux/feishu/agent-deck-feishu.service
deploy/linux/feishu/config.example.json
deploy/linux/feishu/connect.request.example.json
deploy/linux/feishu/credential-rotate.request.example.json
deploy/linux/feishu/disconnect.request.example.json
deploy/linux/feishu/preflight.sh
deploy/linux/feishu/runtime/Containerfile
deploy/linux/feishu/runtime/package-lock.json
deploy/linux/feishu/runtime/package.json
deploy/linux/feishu/static-check.sh
deploy/linux/full/README.snippet.md
deploy/linux/full/connection-issue.request.example.json
deploy/linux/full/server-control.config.example.json
deploy/linux/full/server-core.credentials.example.json
deploy/linux/full/static-check.sh
deploy/linux/manager/README.snippet.md
deploy/linux/manager/linux-headless.package.json
deploy/linux/manager/static-check.sh
deploy/linux/relay/README.snippet.md
deploy/linux/relay/connection-issue.request.example.json
deploy/linux/relay/server-control.config.example.json
deploy/linux/relay/static-check.sh
package.json
pnpm-lock.yaml
resources/bin/agent-deck-feishu
resources/bin/agent-deck-server
scripts/build-feishu-runtime.mjs
scripts/build-linux-headless.mjs
scripts/check-linux-headless-support.mjs
scripts/check-linux-headless.mjs
scripts/deployment/artifacts.mjs
scripts/deployment/deployment.test.mjs
scripts/deployment/feishu-runtime-build.test.mjs
scripts/deployment/remote-check.sh
scripts/deployment/remote-install.sh
scripts/deployment/remote-verify.sh
src/contracts/session-console.test.ts
src/contracts/session-console.ts
src/core/session-console.test.ts
src/gateways/feishu/bounded-operation.ts
src/gateways/feishu/config.ts
src/gateways/feishu/core-verification.test.ts
src/gateways/feishu/core-verification.ts
src/gateways/feishu/event-adapter.ts
src/gateways/feishu/index.ts
src/gateways/feishu/pairing-event-handler.test.ts
src/gateways/feishu/pairing-event-handler.ts
src/gateways/feishu/runtime-shutdown.test.ts
src/gateways/feishu/runtime.ts
src/gateways/feishu/secret-rollback.test.ts
src/gateways/feishu/security-lifecycle.test.ts
src/gateways/feishu/sqlite-delete-confirmation-store.ts
src/gateways/feishu/sqlite-delivery-hardening.test.ts
src/gateways/feishu/sqlite-pairing-delete.test.ts
src/gateways/feishu/sqlite-pairing-store.ts
src/gateways/feishu/sqlite-schema.ts
src/gateways/feishu/sqlite-store.test.ts
src/gateways/feishu/sqlite-store.ts
src/gateways/feishu/types.ts
src/gateways/im/__tests__/fixture.ts
src/gateways/im/__tests__/nonce-fixture.ts
src/gateways/im/audit-fencing.test.ts
src/gateways/im/audit-store-mutation.test.ts
src/gateways/im/command-executor.ts
src/gateways/im/commands.ts
src/gateways/im/core-output.ts
src/gateways/im/delete-confirmation-store.ts
src/gateways/im/errors.ts
src/gateways/im/gateway.test.ts
src/gateways/im/gateway.ts
src/gateways/im/index.ts
src/gateways/im/session-delete.ts
src/gateways/im/store.ts
src/gateways/im/types.ts
src/gateways/im/validated-store.ts
src/hosts/feishu/client-factory.test.ts
src/hosts/feishu/entrypoint.ts
src/hosts/feishu/management-server.test.ts
src/hosts/feishu/management-server.ts
src/hosts/feishu/service.ts
src/hosts/linux-runtime/connection-credential-issuer.test.ts
src/hosts/linux-runtime/connection-credential-issuer.ts
src/hosts/relay/connection-issuer.test.ts
src/hosts/relay/connection-issuer.ts
src/hosts/relay/control-host.test.ts
src/hosts/relay/credential-authority-service.test.ts
src/hosts/relay/credential-authority-service.ts
src/hosts/relay/entrypoint.ts
src/hosts/relay/headless-config.ts
src/hosts/relay/headless-root.test.ts
src/hosts/relay/headless-root.ts
src/hosts/relay/metadata-file.test.ts
src/hosts/relay/metadata.test.ts
src/hosts/relay/metadata.ts
src/hosts/relay/router-credentials.test.ts
src/hosts/server-control/config.test.ts
src/hosts/server-control/config.ts
src/hosts/server-control/connection-authority.ts
src/hosts/server-control/connection-request.ts
src/hosts/server-control/connection-service.test.ts
src/hosts/server-control/connection-service.ts
src/hosts/server-control/entrypoint.test.ts
src/hosts/server-control/entrypoint.ts
src/hosts/server-control/feishu-control-service.test.ts
src/hosts/server-control/feishu-control-service.ts
src/hosts/server-control/feishu-management-client.ts
src/hosts/server-control/feishu-provisioning.ts
src/hosts/server-control/feishu-request.ts
src/hosts/server-control/feishu-rotation.ts
src/hosts/server-control/feishu-runtime-release.ts
src/hosts/server-control/feishu-runtime-verifier.ts
src/hosts/server-control/feishu-status.ts
src/hosts/server-control/systemd.ts
src/hosts/server-core/connection-issuer.test.ts
src/hosts/server-core/connection-issuer.ts
src/hosts/server-core/credential-file.test.ts
src/hosts/server-core/credential-file.ts
src/hosts/server-core/entrypoint.ts
src/hosts/server-core/runtime-composition.test.ts
src/hosts/server-core/session-console-authority.test.ts
src/hosts/server-core/session-console-authority.ts
src/main/remote-host/service-session-console.test.ts
src/main/remote-host/service.test-fixture.ts
src/main/remote-host/service.test.ts
src/shared/feishu-management.ts
```

## Findings and fixes landed

### HIGH — Restricted-Core verification could become metadata-only

Exact advertised grants are necessary but do not prove that Core rejects a forged broader request.
The final probe now sends forbidden `system.health` through the authenticated sidecar channel and
requires the real `access_denied` response in addition to exact product/internal claim equality.
Focused tests cover missing, widened, and non-denying responses.

### MEDIUM — Runtime archive retained unnecessary build attack surface

The first runtime payload retained native source, tests, dependency build inputs, and documentation
that are not required at execution time. The container build now prunes those paths, and the host
builder rejects traversal, duplicates, unexpected roots, source/test/native-build extensions, and
secret-like names. Repeated builds remain byte-identical after pruning.

### LOW — Relay fixture no longer met the strict current credential schema

One control-host fixture still used a null Feishu public key after current connection metadata made
the public key mandatory. The fixture now supplies the exact current key shape; Relay and Remote
service regressions pass.

### LOW — Two touched files crossed the source-size guardrail

The Linux headless checker and a main-process service test exceeded 500 lines after integration.
Runtime validation helpers moved to `check-linux-headless-support.mjs`, and shared service setup moved
to `service.test-fixture.ts`. All changed source files now remain below 500 lines.

No confirmed code finding remains open.

## Security and lifecycle conclusions

- Credential identity, surface, policy version, grant set, issue/rotation/revocation state, Feishu
  pairing, and sidecar lifecycle remain Server-owned. Relay Worker receives only an opaque scope and
  immutable capability context; it does not receive a connection directory or Feishu identity.
- Desktop and Feishu resolve to one explicit versioned grant set. Core validates immutable claims
  mechanically, and stream/credential replacement fences stale authority.
- Management is server-local over a root-owned mode-0600 Unix socket with peer-uid, message-size,
  concurrency, and timeout bounds. App secrets are read from protected files and do not enter argv,
  logs, bundles, status output, or connection exports.
- Pairing codes are 192-bit random values stored only as hashes, expire after ten minutes, are
  single-use, and require local operator approval. Candidate and approval races are transactionally
  fenced; listings expose only redacted fingerprints.
- Session deletion is p2p-only, previews one exact session snapshot, expires after five minutes,
  and uses stable idempotency plus Core compare-and-set to prevent target drift or double deletion.
- Connect, upgrade, credential rotation, restart, verification, rollback, and disconnect use exact
  predecessors and compensating cleanup. Stop-before-revoke disconnect failure is fail-closed and
  retryable; runtime releases are checksum-bound and immutable.

## Validation and evidence

- Focused connection, pairing, deletion, runtime, security, rollback, and topology coverage passed
  21 files / 156 tests; exact expiry/deletion coverage passed 2 files / 23 tests.
- The complete suite passed 962 files / 6,104 tests; 2 files / 3 tests were skipped only by existing
  opt-in guards.
- `pnpm typecheck` passed architecture, Core-node, node TypeScript, and renderer TypeScript checks.
- `pnpm build` and `pnpm verify:linux-headless` passed; the latter rebuilt both runtime artifacts and
  reran Linux-headless and deployment verification.
- `pnpm check:deployment` and Full, Relay, Feishu, and Manager static checks passed.
- amd64 SHA-256 is `3cdcb188a4e8202bed527d5106aed6d0fe01a4da65f27e52cdc252acfb595f44`
  at 45,453,729 bytes; arm64 is
  `a3eae830abad1105218e901c89a3393454fcd9ed882685ebd550a3472a0849b9` at
  45,281,069 bytes. Repeated builds produced identical descriptors and artifacts.
- Ubuntu 24.04 and Rocky Linux 9 containers for both target architectures passed archive-internal
  checksums, Node v22.22.3 / ABI 127 checks, and real bundled `better-sqlite3` execution.
- Review-expiry, changed-source file-size, source/bundle secret-path inspection, and
  `git diff --check` passed. The main/preload development restart was skipped at the user's explicit
  direction not to terminate existing processes; no installed/running instance is claimed as this
  branch's validation.

## Residual risk

No authorized clean systemd/sshd Ubuntu or EL9 host and no tenant-installed Feishu app credentials
were available. Therefore this review does not claim real systemd unit activation, filesystem
owner/mode behavior on a fresh host, SSH forced-command admission, real outbound Feishu long
connection, message/card round trips, reconnect after network loss, credential-revocation teardown,
or provider load behavior. The current branch also was not started as a development instance after
the user directed that existing processes remain untouched. The runbook exposes the live checks as
explicit final acceptance items.

## Follow-ups

During user acceptance, run the documented server install/check/dry-run/connect/verify flow on one
clean Ubuntu host and one EL9-family host, then complete the real Feishu pairing, unauthorized-user,
message/card, deletion, reconnect, rotation, revocation, restart, and load checklist. No repository
remediation is required before those external checks.
