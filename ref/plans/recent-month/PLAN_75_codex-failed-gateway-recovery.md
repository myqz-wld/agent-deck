---
plan_id: 75
title: Codex Gateway recovery after terminal errors
status: completed
created_at: 2026-09-30
completed_at: 2026-09-30
base_commit: 8a9e93a0baf02d89c085f8e9511f3de577dbae58
related_review: REVIEW_306
---

# Codex Gateway recovery after terminal errors

## Goal and invariants

Repair Gateway switching on existing Codex sessions after a connection failure, explain the
stale reconnect message, and check the equivalent Claude/Grok paths. Preserve conversation and
native thread identity, model/thinking choices, permissions, and healthy active turns. Keep user
credentials and running applications outside test mutations.

## Completed work

1. Compared the previous repair with current source and native protocol behavior. Ordinary
   successful-turn Gateway switching passed; terminal-error switching reproduced the stale endpoint.
2. Added failing lifecycle and presentation regressions. Fixed native failure cleanup and made
   the explicit native retry flag authoritative; removed the reconnect emoji.
3. Protected shared ephemeral summary clients and retained the existing bounded cancellation
   fence. Moved the public run-options type to keep the thread implementation at 500 lines.
4. Added an isolated native acceptance test for HTTP 401, HTTP 503, and truncated Responses streams,
   checking actual destinations, unchanged thread identity, and preserved history.
5. Inspected Claude query cleanup/recovery and Grok model acknowledgement paths, then completed
   targeted tests, full tests, typechecking, and the production build.

## Validation and handoff

Full validation passed 6,900 tests with three existing skips, including all three native Gateway
acceptance cases. Typechecking and production bundling passed; the SQLite binding stayed unchanged.

Source work is complete. The affected computer still needs an updated installation and restart;
no live user-owned process or installed application was changed.

Evidence: [Failed Gateway recovery review](../../reviews/recent-month/REVIEW_306_codex-failed-gateway-recovery.md).
