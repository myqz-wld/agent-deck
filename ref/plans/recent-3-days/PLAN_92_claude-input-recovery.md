---
plan_id: 92
completed_at: 2026-10-14
status: completed
---

# Claude input recovery

## Goal and constraints

Prevent unacknowledged input from disappearing on result errors or unexpected SDK stream end.
Preserve original text and attachment references, distinguish unsent from delivery-unknown input,
and never fabricate provider acceptance or automatically replay uncertain work. Preserve concurrent
compaction and activity-feed changes in the shared checkout.

## Decisions and completed tasks

1. Reuse durable system/error message events for recovery; keep them out of user continuation input.
2. Preserve input before retiring queue ownership; seal input so late attachment I/O cannot send
   into a finished stream. Leave intentional cancellation and handoff transfer semantics intact.
3. Preserve accepted-size recovery text through normal SQLite serialization with a bounded exception
   to diagnostic truncation; keep general event/output limits unchanged.
4. Add a recovery card with explicit status, original content, attachment preview, and owner-triggered
   resending. The owner explicitly selected direct resending instead of copying text.
5. Reuse Local image loading and validated sending. Require every attachment and complete text;
   preserve drafts and refresh the pending queue after enqueue. Disable repeated clicks while the
   card is pending or successfully enqueued. Remote records never route into the Local sender.
6. Use the session-scoped Browser CLI to inspect the actual component in an isolated local preview.

## Validation

- Final `pnpm typecheck` passed, including architecture and Core Node boundaries.
- Final full `pnpm test`: 1,170 files / 7,348 tests passed; 3 files / 6 tests skipped.
- SQLite reload, maximum-length Unicode/escaped text, correlated acceptance, failure preservation,
  cancellation/retirement, late attachment completion, exact retry payloads, draft retention, and
  source isolation are covered.
- IAB verified state switching, attachment lightbox, narrow/long content, explicit resend progress,
  successful enqueue, and failure retry. Preview sends use synthetic callbacks, not provider calls.

## Handoff and residual limits

Source work is complete; main-process changes require a separately authorized application restart
or normal update. No running application was restarted or replaced. See
`ref/reviews/recent-3-days/REVIEW_328_claude-unacknowledged-input-loss.md` for findings and limitations.
The local `.ref/claude-input-recovery-preview/` workspace and its IAB tab remain intentionally open
for owner interaction; they are not distribution inputs.
