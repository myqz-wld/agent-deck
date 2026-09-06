---
plan_id: 51
completed_at: 2026-09-06
status: completed
---

# Worktree user-message continuity

## Goal and constraints

Repair messages disappearing while entering or exiting a worktree. Preserve durable acceptance,
one visible acknowledgement per input, attachments, continuation-first ordering, and the atomic
drain seal. Keep stale provider output fenced. Do not change native provider protocols, database
schema, or the running host application.

The user subsequently requested simplifying `README.md` and explicitly deleting the complete
`.prompt-asset-improver` directory. Include those changes without editing bundled conventions.

## Completed work

1. Trace IPC sends through all adapter ingress guards, worktree buffering, coordinator filtering,
   and replay. Confirm that the interruption fence drops accepted user events and that ingress
   discards outgoing correlation ids.
2. Reproduce both enter/exit history loss and missing message correlation before the fix.
3. Retain user acknowledgements through the fence and carry message ids across all three adapters.
4. Test the combined path: visible acknowledgements, attachments, one replay, continuation-first
   ordering, target cwd, and delayed queue release.
5. Reduce README from 141 to 78 lines, retain essential usage and boundaries, and validate its
   links, commands, and Browser documentation.
6. Delete the user-requested prompt-maintenance directory and stale ignore rule after validating
   the README backup and inventory. Keep existing project runtime-safety instructions intact.
7. Finish typecheck, full tests, build, diff checks, review-expiry inspection, and record routing.

## Validation and final handoff

The full suite passed 6,354 tests, with three intentional skips. Typecheck, production build,
13 focused continuity tests, and four subsequent Browser documentation tests passed. The SQLite
binding remained unchanged. The installed application was not updated or restarted.

See [REVIEW_271](../../reviews/recent-3-days/REVIEW_271_worktree-user-message-projection.md) for
evidence, the prompt-asset audit, cleanup authorization, and remaining installed-app validation.
