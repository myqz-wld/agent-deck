---
review_id: 249
reviewed_at: 2026-08-14
baseline_commit: c8026d77727f4353f666403f72105e8c5c5acd64
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Acceptance records and indexes are mechanical evidence derived from the reviewed tree and live run."
---

# REVIEW_249_feishu-relay-live-acceptance: Relay deployment and Server CLI

## Scope and method

This follow-up reviewed the post-implementation deployment fixes and exercised the official Relay
deployment entrypoint on an authorized ARM64 Ubuntu host. It inspected the complete production-code
diff from the final-record baseline through `4fd970044463f392a1606f15e1b4a761ec4b097d`, deployed the
records-only `f6d977adcbd0f1411196c934c3f2380f81f9b01d` release to exercise same-schema lifecycle,
rebuilt both runtime architectures repeatedly in independent processes, and separated real Relay
evidence from still unavailable Full and tenant-installed Feishu evidence.

```review-scope
scripts/build-linux-headless.mjs
scripts/deployment/deployment.test.mjs
scripts/deployment/remote-install.sh
scripts/deployment/remote-relay-authority.sh
scripts/deployment/remote-verify.sh
scripts/deployment/server.mjs
src/hosts/relay/connection-issuer.ts
src/hosts/relay/credential-authority-service.ts
src/hosts/relay/credential-authority.ts
src/hosts/relay/headless-config.ts
src/hosts/relay/headless-root.ts
src/hosts/server-control/connection-authority.ts
src/main/adapters/codex-cli/app-server/translate-collab.test.ts
src/main/adapters/codex-cli/app-server/translate-collab-parameters.test.ts
src/renderer/remote-host/use-remote-session-source.test.tsx
src/renderer/remote-host/use-remote-session-source-refresh.test.tsx
src/renderer/remote-host/use-remote-session-source-detail.test.tsx
src/renderer/remote-host/use-remote-session-source-detail-reads.test.tsx
```

## Findings and fixes landed

### HIGH — Runtime digest changed between independent build processes

The CommonJS auto-wrapper could alternate between wrapped and direct dependency output, so a
single-process double build was insufficient provenance evidence. The Feishu build now enables
strict CommonJS requires, clears each role's Vite cache inside the disposable output root, bounds
parallel file operations, builds all roles twice, and compares the manifest plus every emitted
bundle and source map. Four independent processes produced identical artifacts.

### HIGH — Runtime installation exceeded the small host's safe disk peak

The installer retained the uploaded outer release, extracted runtime, native build tree, and image
build context simultaneously. It now deletes the outer upload after verified release extraction,
extracts into a same-filesystem staging directory, validates checksum and ABI before the atomic
root-owned move, and removes the native build tree before the Podman image build. The live upgrade
completed with bounded free space and an immutable verified runtime.

### MEDIUM — Slow release upload exceeded the generic command timeout

The official deploy command inherited a 300-second timeout that was too short for a large release
on the available link. Release upload now has an explicit bounded 1,200-second timeout while other
remote commands retain their existing bounds.

### HIGH — Mutable Relay credentials invalidated immutable generation evidence

The Server CLI correctly changed Relay's credential directory, but that directory was embedded in
the manager-versioned runtime config. A later upgrade therefore failed closed as tampered. Relay now
uses an immutable schema-v2 runtime config plus a separate service-owned mode-0600 authority file;
the whole exact config directory is mounted read-only so atomic host replacement remains visible to
the running container. A live issue/revoke test reached Relay metadata without a restart.

### MEDIUM — Private authority checks ran as the SSH deployment identity

The first fixed-release attempt correctly denied the deploy user direct traversal of the service
account's mode-0700 config directory. Authority creation and verification now run every directory,
symlink, owner, mode, and schema probe through the restricted service-account context; directory
permissions were not weakened.

### Guardrail follow-up — oversized test suites partitioned

The final file-size inventory exposed three T1.5 test files at 604, 548, and 541 lines. Their test
cases were partitioned into six topic-specific files without changing production code, assertions,
or the total test count. All six focused files passed 33 tests, typecheck passed, and the complete
suite retained all 6,110 tests; the largest changed source file is now 499 lines.

No confirmed code finding remains open.

## Live Relay acceptance

- The official check, dry-run, and independent verify path succeeded after a one-way clean break to
  release `git-4fd970044463`, generation 15. A normal same-schema upgrade created generation 16 at
  `git-f6d977adcbd0`; official rollback created generation 17 at 4fd and a second rollback created
  the final generation 18 at f6d. Each operation returned `VERIFY_OK` with Relay healthy and the
  Feishu runtime ready.
- Final current/previous records are f6d/4fd. Installed schema-v2 config and unit digests match the
  current record, retained backups match their recorded digests, and no operation journal remains.
- The running image is digest-pinned and the manager reported the exact active generation healthy.
  The exact managed Relay unit was restarted once and independently verified healthy; no local or
  unrelated process was terminated.
- Because this unreleased project intentionally has no compatibility contract, the old v1 metadata
  file was removed only inside the manager's exact stop window after identity, owner, mode, and
  schema validation. The current service recreated schema v2 successfully.
- The existing Desktop authorized-key line still used retired surface `desktop-full`. It was changed
  to canonical `desktop` only after the complete replacement line was proven byte-equal to the
  current generator apart from that token. The credential and public key were preserved and the
  service was not disconnected.
- The installed Server CLI passed `connections verify` and `connections list`. Two disposable
  credentials exercised `issued`, `already-issued`, `rotated`, `already-rotated`, `revoked`, and
  `already-revoked`; both final records are revoked and no disposable authorized key remains.
- A follow-up disposable connection proved the separate authority and Relay metadata changed from
  active to revoked within the polling bound while the exact container start timestamp stayed
  unchanged. Its private output was deleted and its authorized key was removed.
- The connection authority survived both official rollbacks unchanged: one active Relay Worker and
  five owner/client history rows. The CLI projection correctly excludes the Worker and reports one
  active Desktop connection plus four revoked disposable rows.
- `feishu check` and `feishu status` passed. The final arm64 runtime is installed and verified; the
  sidecar remains deliberately inactive because no app credentials were supplied.
- The Relay remained healthy while its Worker route was offline. This proves independent Relay
  lifecycle, but does not claim a Core session, pairing, message, card, or deletion round trip.
- Eleven unreachable development images were removed from this dedicated acceptance host only
  after resolving and preserving the manager's current image, previous image, and running
  container. No credential, instance record, business data, or active image was deleted.

## Validation

- Merged full suite: 966 files / 6,112 tests passed; 2 files / 3 tests remained skipped behind existing
  opt-in guards.
- `pnpm typecheck`, `pnpm build`, `pnpm verify:linux-headless`, `pnpm check:deployment`, Full,
  Relay, Feishu, and Manager static checks, review expiry, changed-source file size, and
  `git diff --check` passed.
- Independent builds reproduced amd64
  `f1a5392b0635a47b08cb9e1b066f38302ad9c8192e170029182338e813777d52`
  (45,471,494 bytes) and arm64
  `59bc3544f016c2b920e1b956c84e731eedec98e8778b3a42f97df27cfd72d2af`
  (45,287,836 bytes).
- The exact remote Relay restart, normal schema-v2 upgrade, two official rollbacks, and verification
  after every transition passed. The repository-required main/preload development restart remains
  intentionally skipped under the user's instruction not to terminate existing processes.

## Remaining external acceptance

No authorized Full host, EL9-family systemd host, or tenant-installed Feishu application credentials
were available. Full deployment and real Feishu pairing, unauthorized-user rejection, message/card,
confirmed session deletion, reconnect, credential rotation/revocation teardown, and load behavior
remain external acceptance items. No result in this record claims those flows.
