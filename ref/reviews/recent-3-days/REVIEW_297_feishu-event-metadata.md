---
review_id: 297
reviewed_at: 2026-09-29
baseline_commit: 11ae3948736f5e198db3a884510f0e6dfb175392
expired: false
---

# Feishu long-connection event metadata

## Scope and method

Live event diagnosis, failing synthetic reproductions, complete changed-scope inspection and
official-SDK regressions. No independent agents or paired review were requested.

```review-scope
src/gateways/feishu/mapper.ts
src/gateways/feishu/mapper-transport.test.ts
src/gateways/feishu/message-semantics.test.ts
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
- All three modified modules remain below 500 lines. Review-expiry inspection covers the complete
  changed scope directly, without relying on legacy or expired records.
- The temporary live diagnostic closed after capture and its generated module was removed.
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

The old unused pairing code expired and its plaintext was removed. A fresh one-time pairing
command was placed only in the local clipboard and private temporary storage for the owner.
The official pre-create list contained no requests; approval and business acceptance are pending.

Retain the active Feishu plan until private-chat commands, a real provider response and a harmless
card action are verified. The redacted SDK error accompanying rejected events is not independently
explained; check acknowledgement and event-log outcomes after activation rather than assuming it
was resolved by parser changes.
