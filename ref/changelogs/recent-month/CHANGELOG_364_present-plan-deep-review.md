---
changelog_id: 364
changed_at: 2026-07-14
---

# CHANGELOG_364_present-plan-deep-review: Block plans and review them in an isolated fork

## Summary

`present_plan` is now a durable human gate. Omitting `timeoutMs` waits indefinitely. An explicit
timeout still returns `decision: "timeout"` for compatibility, but Agent Deck keeps the plan card
pending and requires the calling session to stop. A later approval or revision is delivered as a new
user turn to the current logical owner, including the latest committed handoff successor, so the
workflow resumes from the same gate without polling or re-presenting.

MCP plan cards also gain a Deep Review action. It opens a full-screen selectable plan, lets the user
quote selected text into a dedicated question composer, and converses with one isolated native fork
of the presenting session. The user can approve, continue modifying with optional feedback, or ask
the child to derive and automatically submit focused revision feedback from inherited chat context.

## Plan gate lifecycle

- Removed the generic permission-timeout default from `present_plan`; `present_diff` retains its old
  timeout policy.
- Added active and timed-out pending states. Explicit timeout no longer emits cancellation or removes
  the card, and late-delivery failure leaves the decision retryable.
- Resolving, cancelling, or closing the owning plan session closes the review child while preserving
  its recorded history and lineage.
- Late approval and revision messages follow current logical ownership after handoff, so the latest
  committed successor receives them.

## Isolated review session

- Reuses the provider-native fork path with the same adapter and real cwd, source model / Thinking,
  permission mode, sandbox, extra writable roots, and persisted Codex network / directory access.
- Keeps the durable spawn edge but suppresses normal wire-prefix, lead-context, and reply-placeholder
  injection. Public `spawn_session` output and behavior remain unchanged.
- Queues questions as serialized child turns. Automatic feedback waits for its uniquely marked user
  turn and corresponding completion, so unrelated in-flight output cannot be submitted as feedback.
- Uses a focused read-mostly runtime instruction and never silently falls back to `fresh`.

## Review interface

- Adds a portal-backed full-screen dialog with the complete Markdown plan and a live child
  conversation.
- Captures plan selections and inserts them as Markdown blockquotes at the question cursor.
- Keeps approve and two-step continue-modifying behavior aligned with the compact card.
- Explains that context-derived feedback is automatically submitted to the current plan-owning
  session.

## Validation

- Added focused tests for the state machine, native-fork isolation, inherited access, marked
  feedback collection, handoff rehome failures, pending-recovery child cancellation, late delivery, and
  renderer interactions; existing plan and diff suites were updated without changing
  `present_diff` semantics.
- `pnpm test` passed 306 files and 2,829 tests; one opt-in live smoke remained skipped.
- `pnpm typecheck` and `pnpm build` passed for the complete node, preload, and renderer targets.
- A final `pnpm dev` launch rebuilt all three Electron targets; the already-running installed host's
  single-instance lock prevented a second window, so loading the change there requires a safe
  restart/rebuild.
- In-app Browser attachment could not initialize because the Browser skill reported
  `Cannot redefine property: process`; renderer component tests cover the interaction path instead.
- All changed first-party implementation files remain below 500 lines.

## Do Not Split Protection

- Retained timeout state and late user-turn delivery are one lifecycle contract; returning timeout
  without retaining the card would again let the human gate disappear.
- Silent spawn context, read-mostly prompting, and no-fresh-fallback are one isolation boundary.
- Marked feedback collection and automatic submission must remain paired so a prior child response
  cannot be mistaken for the requested plan feedback.

## Related records

- [REVIEW_159](../../reviews/recent-week/REVIEW_159_present-plan-lifecycle.md)
- [PLAN_10](../../plans/recent-week/PLAN_10_present-plan-deep-review.md)
