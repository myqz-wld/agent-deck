---
review_id: 297
reviewed_at: 2026-09-29
baseline_commit: 3001b359ae287128a4124e8f6608790b508c97e5
expired: false
---

# Feishu live events and WebSocket acknowledgements

## Scope and method

Live event diagnosis, failing synthetic reproductions, complete changed-scope inspection and
official-SDK regressions. No independent agents or paired review were requested.

```review-scope
src/gateways/feishu/mapper.ts
src/gateways/feishu/mapper-transport.test.ts
src/gateways/feishu/message-semantics.test.ts
scripts/build-linux-headless.mjs
scripts/check-linux-headless.mjs
scripts/check-feishu-websocket-bundle.mjs
scripts/deployment/remote-storage-budget.mjs
scripts/deployment/server.mjs
scripts/deployment/storage-budget.mjs
scripts/deployment/storage-budget.test.mjs
src/gateways/im/audit-transport-retirement.test.ts
src/gateways/im/client-pool.ts
src/gateways/im/types.ts
src/hosts/feishu/client-factory.ts
src/hosts/feishu/client-factory.test.ts
src/hosts/server-control/feishu-control-service.ts
src/hosts/server-control/feishu-runtime-integrity.ts
src/hosts/server-control/feishu-runtime-references.ts
src/hosts/server-control/feishu-runtime-release.ts
src/hosts/server-control/feishu-runtime-retention.ts
src/hosts/server-control/feishu-runtime-retention.test.ts
src/hosts/server-control/feishu-runtime-upgrade.ts
```

## Findings and fixes

HIGH: The message/card mapper rejected an empty header verification token. App-authenticated
long-connection events can contain this value; the token is metadata in this outbound adapter,
not an authentication decision. Allow the empty string while retaining the required field and
type, size and control-character validation for other values.

HIGH: The mapper also rejected `null` in optional user identifiers. A bounded diagnostic using
the official SDK captured a real owner help event with a valid required `open_id`, nonempty
`union_id`, empty header token and `user_id: null`. Its exact failure was
`sender.sender_id.user_id is malformed`. Only field shapes and the fixed error were retained.
The initial token repair was necessary but did not resolve this second rejection.

Treat null and absent optional identity metadata equivalently in senders, mentions and card
operators. Required sender/operator `open_id`, at least one usable mention ID, app/tenant binding,
unknown-field rejection, non-null malformed values and card nonce validation remain enforced.
No additional Feishu scope, credential enrollment, database migration or Desktop replacement is
needed. Authentication and owner pairing remain mandatory.

HIGH: After pairing and help replies started working, Feishu still retried accepted events.
A bounded diagnostic using the actual bundle confirmed successful mapping and a 200 ACK payload,
then `bufferUtil$1.mask is not a function` while sending the WebSocket frame. Vite replaced the
absent optional `bufferutil` peer with empty exports, so ws selected a nonexistent native masking
function for larger frames. Small pings and earlier fake-socket probes missed that boundary.

Pin the Feishu bundle to the upstream-supported JavaScript masking path at build time using
`WS_NO_BUFFER_UTIL`. This avoids an additional native package and runtime environment dependency;
TLS, masking, app binding and owner authorization stay enabled. See the
[upstream ws performance options](https://github.com/websockets/ws#opt-in-for-performance).

Add a build/package gate against the actual bundled Sender/Receiver codec. It exchanges masked
binary frames at 0/31/32/47/48/49/125/126/1024/65536-byte boundaries, validates decoded bytes and
preserves the read-only caller buffer. The service invocation alone is suppressed in a temporary
copy; dependency definitions remain intact, and the copy is always removed.

## Validation

- Empty-token mapper and official-SDK/real-gateway regressions failed before the first repair.
- The captured nullable-ID shape produced six failing tests before the second repair. All 51
  focused tests passed afterward, including required-ID and malformed optional-ID rejection.
- Integrated typecheck passed. The full suite passed with four workers: 6,682 tests passed,
  three existing skips, and 1,078 passing files. Default-concurrency runs each failed one different
  unrelated async UI case (RemoteIssuesPanel and B18ConventionEditors); both entire files passed
  in isolated reruns. No test assertion or production UI code was relaxed for this repair.
- Integrated Linux headless reproducibility, both pinned runtime builds, packaging/deployment
  gates and all four topology/manager static checks passed. Actual archive inspection covered
  37 members and 26 regular files per architecture, with root ownership and safe paths. Both
  archives and all generated Node bundles excluded current private values and machine paths.
  The shared Electron SQLite binding hash remained unchanged.
- All modified modules remain below 500 lines. Review-expiry inspection covers the complete
  changed scope directly, without relying on legacy or expired records.
- The old runtime bundle failed the new masking gate. The repaired headless build and its
  reproducibility/transport checks passed. Final masking-release validation also passed: all
  6,682 tests (four workers), typecheck, both pinned runtime builds, headless/deployment gates and
  all four topology/manager checks. Both new archives and eleven generated bundles passed the
  private-value/path audit, and the shared SQLite binding hash was unchanged.
- Both temporary live diagnostics closed after capture and their generated modules were removed.
  Private operational evidence and credentials remain outside the repository.

## Release and remaining acceptance

The first repair was activated through official Server and Feishu upgrade/verify commands, with
matching runtime digests and healthy Worker, WebSocket and Core connections. Real messages still
failed on the nullable ID, so transport health was not accepted as business delivery evidence.

The second repair and the latest main branch are integrated on the repair branch. Both review
index entries were retained. Official Server check, dry-run, upgrade and verify passed for
`9dee12dd3c32ec703beaeb4ba5e5dd5dbf41fbf5`. Official Feishu upgrade/verify and Worker verify passed.
Active and desired Feishu digests match the inspected artifact; no runtime update remains, and
service, WebSocket and restricted Core connections are healthy. Rebuilt artifact hashes also
match the pre-release audit. No Desktop replacement or credential re-enrollment occurred.

The owner received the fresh pairing-submitted response. The single fresh pending request was
approved through the official CLI. Owner verification passed, and the user received the help
command list. Consumed pairing plaintext was removed; the clipboard had changed and was preserved.

The masking repair was activated as `5aff43310f074b85c28930b01409b3881e3e1906`. Official Server
check/dry-run/upgrade/verify, rebuilt artifact identity, Feishu upgrade/verify and Worker verify
all passed. Active/desired runtime digests match and no update remains. Owner pairing survived;
service, WebSocket and restricted Core are connected. No Desktop process or bundle was changed.

Retain the active plan until new command delivery is acknowledged without retry, directory listing,
a real provider response and a harmless card action are verified. The owner is testing a fresh
`/directories` command; pairing must not be recreated.

## Storage incident and recovery

A later directory command arrived after the Relay root filesystem had exhausted its free space.
The event mapped successfully, but handling failed with `internal_error`; Worker verification
still passed. Feishu metadata integrity was intact. The cloud disk is 8 GiB with approximately
7 GiB allocated to root. Eight Feishu runtimes occupied about 1 GiB, and a separate 1-GiB
container filesystem had only about 64 KiB in use. Feishu metadata itself was about 104 KiB.
These figures describe deployment overhead, not replicated conversation history.

One inactive rotated log and six retired runtime directories were streamed to private local
backups. The log content and every runtime file were verified against checksums before removal.
Cleanup rechecked active/desired pointers and live executable/mapped paths, retained the preceding
accepted runtime, and preserved credentials, databases, provider installations and active services.
Two runtime releases remain; root free space recovered to about 846 MiB. Feishu verification
passed again with owner pairing, Core and long connection intact, without a process restart.

The owner explicitly brought free-space budgeting and bounded runtime retention into this delivery.
Issue `2665f501-3a71-4408-a61c-160ec2b52a48` is in progress. No cloud disk resize was authorized or
performed. Post-recovery directory delivery, provider response and card acceptance remain pending.

## Terminal transport recovery and storage prevention

HIGH: A cached chat client outlived its permanently failed SSH transport. A fresh connection could
read the project catalog and directory list, but the service had no live SSH child and repeatedly
returned `internal_error` for the existing chat. Synthetic reproduction confirmed the cache never
retired the failed transport. Observe permanent offline/incompatible/closed states, fence the old
generation and wait for its retirement barrier before admitting the next client. Transient SSH
reconnects remain transport-owned. Synchronous terminal snapshots and stale listeners are covered.

HIGH: Release upload/extraction lacked a free-space check, and each successful runtime upgrade
retained all previous immutable versions. Calculate compressed and expanded archive allocations,
combine budgets on shared filesystems and require 256 MiB of free headroom before uploading.
The budget checks release staging, runtime installation and the service filesystem; it does not
reserve space against unrelated writers or predict arbitrary uncached container image downloads.

After runtime health acceptance, record the known preceding runtime as rollback and prune obsolete
digest directories. Verify complete internal checksums, canonical paths, ownership, modes and file
types. Preserve active/desired, the verified rollback, live executable/cwd/mapped/open-file references,
unknown files and any changed tree. Missing history or unreadable process references skips cleanup.
Repeated activation of the same release preserves recorded rollback. Partial cleanup reports its
status without reverting the healthy service. Credential rotation and databases are outside scope.

Extract upgrade orchestration from the control service to keep every changed source below 500
lines. Its rollback now also covers daemon-reload failure before restart. Forty-one focused tests,
typecheck and the full four-worker suite passed: 6,696 tests, three existing skips, and 1,081 passing
files. Linux headless/runtime and deployment gates passed. Both actual archives (37 members and
26 files each) and eleven Node bundles passed privacy inspection; the SQLite binding was unchanged.
Official activation and actual cleanup results remain to be recorded before resolving the issue.

The user also requested conversational operation. Initial inspection found that ordinary text
requires manual session selection and subscriptions deliver state notices without assistant text.
That feature remains under the active plan; it is not covered as completed by these repairs.
