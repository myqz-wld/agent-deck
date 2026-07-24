---
changelog_id: 390
changed_at: 2026-07-24
---

# CHANGELOG_390_provider-acceptance-message-lifecycle: Align deferred input visibility

## Summary

Align Claude, Codex, and Grok outgoing-message lifecycle handling around the provider-acceptance
boundary instead of local dequeue. Messages remain cancellable while queued or submitting, enter
chat only after acceptance, and remain in history after completion or interruption.

## Changes

### Acceptance boundaries

- Claude assigns the deferred input UUID to the SDK message and emits the user event only when the
  matching SDK user echo is received.
- Codex app-server streams an explicit `turn.accepted` event after `turn/start` response or
  `turn/started` notification; the bridge emits deferred input at that event.
- Grok confirms deferred input on the first ACP `user_message_chunk` and no longer emits it when
  the FIFO item is merely dequeued.

### Cancellation and pending state

- Pending-message listings include the provider-submission window for all three adapters.
- Claude uses the SDK async-message cancellation endpoint when available; Codex aborts an
  unaccepted turn and interrupts it if app-server returns a turn id later; Grok sends ACP
  `session/cancel` before acceptance.
- Provider acceptance wins the cancellation race; accepted messages cannot be individually removed.
- Renderer refreshes pending state after terminal outcomes so rejected or cancelled inputs do not
  remain as stale waiting rows.

### Active-turn input

- Codex submits active-turn steer requests in the background and keeps them cancellable until
  `turn/steer` is accepted, without interrupting the running turn when the steer is cancelled.
- Grok submits active-turn interjections through `_x.ai/interject`, keeps them pending until the
  request is accepted, and falls back to the FIFO queue when the installed ACP does not support
  interjection.

## Validation

- `pnpm typecheck`
- `pnpm test` (358 files passed, 1 skipped; 3,050 tests passed, 1 skipped)
- `pnpm build`

## Do Not Split Protection

- `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts` remains above 500 lines
  because it is the established single dispatch point for Claude SDK message translation and
  usage accounting. The new acceptance hook is already extracted into its own module; revisit a
  broader split when another independent translation family is added.

## Related records

- `CHANGELOG_388_grok-mid-turn-interjection.md`
- `CHANGELOG_379_plan-review-pending-queue-composer.md`
