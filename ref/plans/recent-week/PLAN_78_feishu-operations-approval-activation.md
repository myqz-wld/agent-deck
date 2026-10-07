---
plan_id: 78
completed_at: 2026-09-30
status: completed
---

# Feishu operation acceptance and approval activation

## Goal and authorization

Finish the remaining owner-requested operation checks and activate clearer expired-card guidance.
The owner subsequently requested a more natural assistant character voice and explicitly deferred
the older recovered no-reply investigation. Existing authorization covers the same managed Relay
Server and Feishu upgrade; no Desktop/Worker replacement was needed or performed.

## Accepted real operations

- The owner selected existing work, renamed it, and sent a harmless task. The reply card used the
  new name while preserving its canonical ID.
- The existing assistant created a disposable fixture through native tools. A read-only local
  check confirmed the intended two files, disposable folder and separate empty work directory.
- The owner approved natural work creation in that existing Workspace-relative work directory.
  The real provider executed pwd and reported exactly the requested directory, using the saved
  work configuration.
- The owner asked the assistant to delete only the disposable file and disposable folder.
  Independent inspection confirmed both were removed and only the preserved work directory
  remained. The new work and its directory are retained as requested.

No dedicated filesystem-management MCP or UI was added. Native adapter tools, Workspace boundaries
and existing approval controls handled the file operation. This is actual acceptance for the
current Codex assistant, not a claim that every adapter has identical native behavior.

## Delivered source and managed activation

- Source release: `b3c03c94ac991b1596bbda622b32774ba5def288`.
- Active/desired arm64 Feishu runtime:
  `72e32a9b7ec38b52e7693ace991fabe233f7af09a4727e4f91a808e9607c48dd`.
- Source repairs are documented in [REVIEW_308](../../reviews/recent-week/REVIEW_308_feishu-expired-approvals.md)
  and [REVIEW_309](../../reviews/recent-week/REVIEW_309_feishu-assistant-voice.md), with
  [CHANGELOG_666](../../changelogs/recent-3-days/CHANGELOG_666_feishu-expired-approvals.md) and
  [CHANGELOG_667](../../changelogs/recent-3-days/CHANGELOG_667_feishu-assistant-voice.md).

Committed and pushed both source changes, then ran official Server check, dry-run, upgrade and
verify. The first check stopped before remote mutation because the local feature branch lacked
tracking configuration; it was set to the already-pushed origin/main and process-scoped authenticated
Git access was reused. A single successful Server upgrade published the desired native runtime;
one official Feishu upgrade and verify activated it. Platform and Core connections are healthy.

The installed Desktop/Worker remain the accepted `51e57942` release. Independent inspection still
finds one formal GUI and the unchanged installed ASAR. Pairing, history and native runtime choices
were not reset. No database migration, new permission scope or new model selection was performed.

## Validation

51 callback/presentation tests and 19 conversation/update tests pass. The final full suite passes
6,919 tests with six existing skips. Types, architecture, reproducible headless build, both native
builds, headless/deployment checks and artifact privacy audits pass. Both native archives contain
26 regular files and the exact built Feishu bundle. The Electron SQLite binding is unchanged.

Assistant setup version 2 updates existing conversations once through the established recorded
idempotency mechanism. The work prompt and all management/permission rules are unchanged. Local
prompt inventory and paired-asset checks are recorded in REVIEW_309.

## Remaining feedback and handoff

The owner supplied an ordinary reply with a natural greeting and the retained test word. Voice
activation and preserved assistant history are live-observed. The optional old-card click has no
reported result; its actual toast is not claimed as owner-accepted. The three functional checks
above are complete.

The owner also requested a Markdown display strategy. Current plain assistant output uses text;
the official Feishu content-structure page confirms title-less post with an md node supports
CommonMark 0.31 and GFM. The recommendation is plain text for simple chat and rich post for formatted
content, while retaining work/approval cards. That format change is not implemented in this release;
its implementation continues separately in the active follow-up plan.

Private lifecycle status, fixture evidence and logs remain outside Git under
`$HOME/.agent-deck/diagnostics/feishu-final-followups/`. Preserve the other task's ask-user work
in main. The older no-reply incident is deferred by the owner, not declared fixed.
