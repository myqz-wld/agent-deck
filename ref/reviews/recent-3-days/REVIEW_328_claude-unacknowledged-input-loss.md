---
review_id: 328
reviewed_at: 2026-10-14
baseline_commit: bc2008462869df3610c23b28c9b10ca9bc62e036
expired: false
---

# Claude unacknowledged input recovery

## Scope and method

The owner reported that sent user input disappeared from the interface, then authorized repair
and selected direct resending instead of a copy button. Source tracing and deterministic SDK
frames reproduced two terminal loss paths. This is debugging and regression validation, not a
paired reviewer run or a live model reproduction. Concurrent compaction/feed changes were preserved.

```review-scope
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.ts
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts
src/main/adapters/claude-code/sdk-bridge/user-message-recovery-core.ts
src/main/adapters/claude-code/sdk-bridge/user-message-recovery-core.test.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts
src/main/adapters/claude-code/sdk-bridge/stream-finalize-core.ts
src/main/store/payload-truncate.ts
src/main/store/payload-recovery.test.ts
src/main/store/__tests__/message-delivery-recovery.test.ts
src/shared/message-delivery-recovery.ts
src/renderer/components/activity-feed/rows/message-row.tsx
src/renderer/components/activity-feed/rows/message-recovery-row.tsx
src/renderer/components/activity-feed/rows/message-recovery-row.test.tsx
src/renderer/components/activity-feed/rows/resend-recovered-message.ts
src/renderer/components/activity-feed/rows/resend-recovered-message.test.ts
```

The review-expiry helper exited during historical scope mapping. All listed source was directly
inspected; prior reviews did not exempt any file. In the two shared translation/message-row files,
this repair owns only terminal recovery and recovery-card dispatch, not the concurrent compaction work.

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | An uncorrelated error result before idle-input acknowledgement cleared the submitting slot without persisting a user event. | Persist a delivery-unknown system record before clearing the slot. Preserve the slot if persistence throws. |
| HIGH | Unexpected SDK stream finalization removed both submitting and queued input from pending-list lookup. | Preserve submitting input as delivery-unknown and queued input as not-sent before removing runtime ownership. Seal input and ignore late attachment I/O. |
| MEDIUM | Normal diagnostic serialization truncated text at 64 KiB, which would corrupt longer recovery originals. | Preserve recovery payloads within the existing 102,400-character ingress limit and a 1 MiB serialized cap. Ordinary payload limits remain unchanged. |
| MEDIUM, conditional | Mid-turn input with exclusively rewritten/uncorrelated frames can remain pending. | Do not invent acceptance. The terminal recovery repair preserves it if the stream ends; automatic reconciliation of legacy ambiguous frames remains outside this fix. |

## Final behavior

- Recovery records retain exact original text and uploaded attachment references as system/error
  messages. They do not become accepted user messages or continuation user instructions.
- Record each thunk once, only after event emission succeeds. A persistence failure retains queue
  ownership. Normal acceptance now also clears its slot only after emitting the durable user event.
- Expected closure, cancellation, and handoff retirement retain their existing ownership rules.
- The card distinguishes not-sent from delivery-unknown input, displays original content and local
  images, and provides **重新发送**. No provider operation runs without an explicit owner click.
- Local resend reloads every retained image, uses the normal validated send API, and refreshes the
  authoritative pending queue without replacing the composer's current draft. Missing attachments
  or incomplete text block sending rather than silently dropping content.
- Sending disables the button. Success reports **已加入队列**, not provider acceptance; failure
  retains the record and offers another explicit attempt. Completion cannot mutate a replacement
  session's card. Queue-refresh errors cannot turn an accepted send into a retryable send failure.
- Remote projected records cannot invoke the Local sender; direct Remote replay requires a future
  source-authoritative endpoint. Remote text may be redacted/truncated and attachment paths removed.

## Evidence and validation

- Original investigation: 95 existing tests passed despite the defect. Three synthetic probes
  reproduced two loss cases and one conditional pending case.
- Historical baseline probes remain at `ref/reviews/evidence/claude-input-loss/probe.test.ts`.
  Their loss assertions describe the pre-fix baseline and intentionally no longer pass for the
  repaired terminal paths. Current regression coverage lives in the scoped `src/` tests above.
- SQLite validation reloads a maximum-size Unicode original and its attachments after runtime
  removal. Serializer coverage includes JSON escaping, hard size bounds, and partial projections.
- Targeted Core, lifecycle, IPC, composer, and storage validation passed. Final resend tests cover
  click-only delivery, duplicate-click suppression, failed retries, attachment-only input, missing
  images, source isolation, and preserving the current draft.
- Final `pnpm typecheck` passed architecture/Core boundaries and both TypeScript projects.
- Final full `pnpm test`: 1,170 files and 7,348 tests passed; 3 files and 6 opt-in tests skipped.
  Earlier full runs encountered concurrent compaction test/type edits; the final checks above
  supersede those intermediate working-tree failures.
- `git diff --check` passed. All files changed by this repair remain below 500 lines.

## Interactive verification

Used only the session-scoped Agent Deck Browser CLI on the local `.ref/claude-input-recovery-preview/`
page. Snapshots and screenshots verified both statuses, long content in a narrow card, local image
lightbox, sending progress, successful enqueue, and visible failed-send retry. The preview imports
actual production UI but uses synthetic images and a simulated sender; it performs no provider call.
The preview tab and its local server remain open intentionally for the owner.

## Residual risk and activation

This fixes orderly result/stream terminal paths; it does not add a durable outbox for abrupt process
termination or power loss before those paths run. Attachment files retain the existing upload
retention policy. Delivery-unknown records can represent already-delivered work, so the explicit
resend may duplicate provider actions; the card keeps that distinction visible. A successful card
is disabled while mounted, not a durable cross-restart resend lock.

Main-process changes require a separately authorized development restart or normal application
update. No installed application or live provider session was restarted/replaced. No real user
messages, private paths, credentials, or copied provider configuration entered the test artifacts.
The local preview is intentionally non-final; prior `.ref/` previews and packaging diagnostics were
preserved as other-task material. Completed plan: `ref/plans/recent-3-days/PLAN_92_claude-input-recovery.md`.
