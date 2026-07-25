---
changelog_id: 379
changed_at: 2026-07-21
---

# CHANGELOG_379_plan-review-pending-queue-composer: Isolate review and preserve pending input

## Summary

Plan review now allocates its hidden native fork only after the first question, creates feedback from
a fresh plan-plus-dialogue one-shot, and returns an editable no-dialogue default without invoking a
provider. Ordinary chat input remains in a deletable waiting queue until the adapter consumes it,
and the composer can open in a full-frame editor without changing draft or send semantics.

## Changes

### Lazy and hidden plan review

- Added the monotonic `sessions.hidden_from_history` flag and excluded hidden rows from every
  History query while retaining normal runtime lookup for an open review dialog.
- Made trusted plan-review creation set that flag and deferred native-fork creation until the first
  valid review question is submitted.
- Generate feedback in an adapter-matched, tool-free fresh one-shot from the presented plan and a
  bounded post-fork user/assistant transcript only.
- When no question created a review conversation, skip both fork and one-shot work and place the
  editable text `尚未进行审阅对话，暂无修改意见。` in the feedback editor.

### Consumption-aware outgoing queue

- Added adapter-owned pending-message list/delete operations and IPC/preload/shared-type wiring.
- Keep ordinary input above the composer until provider consumption produces the authoritative
  user event; deleting a pending item also performs best-effort attachment cleanup.
- Kept Claude deferred attachment materialization inside the authoritative queue through its read
  race, and preserved Codex active-turn steering instead of forcing it into the idle queue.
- Documented hand-off ingress as a separate durable cutover transaction rather than ordinary live
  provider-queue input.

### Expanded composer

- Added a top-right expand action and a full-frame modal editor backed by the same controlled draft,
  attachments, paste/drop handling, IME guard, and send path as the inline composer.
- Added focus trapping, background inertness, Escape close, and focus restoration.
- Extracted focused composer and Claude user-message-stream modules so all changed production
  source files remain at or below the repository's 500-line guardrail.

## Validation

- `pnpm typecheck`
- `pnpm test`: 324 files and 2,925 tests passed; one existing credentialed live smoke was skipped.
- `pnpm build`
- `pnpm logger:check`
- Focused plan-review, migration, adapter-queue, race, and renderer suites passed during development.
- Final archive, review-expiry, line-count, link, and diff checks are recorded in `REVIEW_165`.

## Do Not Split Protection

None. `stream-processor.ts` was reduced to 495 lines and the new responsibilities were extracted
into focused modules.

## Related records

- `PLAN_15_plan-review-pending-queue-composer.md`
- `REVIEW_165_plan-review-message-consumption.md`

## Deployment note

Main and preload changes require a later application restart to take effect. No development or
installed application process was started after validation, per the user's explicit instruction.
