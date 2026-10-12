---
plan_id: 83
title: Browser recovery after idle session closure
status: completed
created_at: 2026-10-11
completed_at: 2026-10-11
base_commit: 11cfd0cf4d8259d0a7f4e71b5955ff5c10c72171
related_review: REVIEW_317
---

# Browser recovery after idle session closure

## Goal and constraints

Repair repeated Codex turn failures after an idle day while preserving session identity,
conversation history, Gateway/model selection, and provider controls. Revoke Browser access
during idle closure and preserve permanent cleanup for explicit close, deletion, and handoff.
Do not alter live applications, installed bundles, credentials, or concurrent dependency work.

## Completed work

1. Traced the default 24-hour closure to removal of the Browser runtime behind a retained Codex
   client. Reproduced the screenshot's exact exception in process startup.
2. Added suspended Browser state for idle sessions still owned by an SDK. Close tabs and revoke
   the lease immediately; renew the original layout only at a trusted provider-turn boundary.
3. Made process-time Browser renewal best-effort while keeping revoked/suspended access closed.
4. Added lifecycle regressions and checked rename, replacement, shutdown, storage failures,
   native-id claims, and shared Claude/Codex/Grok behavior.
5. Completed typechecking, focused tests, native Gateway recovery, and the full regression run
   followed by successful bounded-concurrency reruns of its three timeout files.

## Validation and handoff

Focused validation passed 35 tests; native Gateway acceptance passed all 3 cases. Typechecking
passed. The full suite passed 7,083 tests, with 3 timeouts and 6 opt-in skips; the timeout files
then passed all 9 tests with two workers. The SQLite binding was unchanged.

Source delivery is complete. The running application still needs an approved update/restart;
this task performed no live process or installation actions.

Evidence: [Browser idle recovery investigation](../../reviews/recent-3-days/REVIEW_317_browser-idle-resume.md).
