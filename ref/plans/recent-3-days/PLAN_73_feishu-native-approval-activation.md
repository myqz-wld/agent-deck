---
plan_id: 73
completed_at: 2026-09-30
status: completed
---

# Activate native approval delivery repair

## Goal and constraints

Restore the missing approval card for the owner's natural work-creation request. Preserve the
pending operation, saved model/native controls, pairing and histories. Reuse the authorized
managed Server/Feishu upgrade scope; keep the accepted Desktop and Worker running. No agents,
worktrees, branches, database migrations or prompt changes are involved.

## Completed work

- Confirmed pending.list rejected a valid native structured model selection at JSON depth nine.
  The request was only 3,183 bytes and had never reached Feishu transport.
- Committed and pushed the bounded payload-depth repair as
  `d4d0d0b458c398202c4a4c268ef59ec91bfd1f2b` on main.
- Ran official managed Relay check, dry-run, upgrade and verify, followed by the managed Feishu
  runtime upgrade and independent verification. All stages succeeded.
- Verified the activated arm64 runtime and desired runtime both equal
  `ce8a97de16667d4d5a556e6144b8bd26d373f7875d48df8364ed25735999f1ca`.
  Feishu service is active; its platform and Core connections are connected.
- The original failed notification resumed through normal subscription replay and reached
  transport successfully on attempt two. Core still holds the same pending permission request.
  No work session was duplicated and no approval was submitted for the owner.
- A read-only probe using the activated bundle and default limits validates the original request
  and renders an actionable 2,236-byte card. No relaxed live configuration or synthetic message
  is used. The owner has been asked to approve the delivered card.
- Desktop remains the accepted 3ea release with its verified ASAR, one GUI and the formal
  application path. The unchanged Worker verifies healthy with its provider supervisor running.
  No Desktop replacement or Worker upgrade was performed.

## Validation

Nine focused tests and 6,892 full-suite tests pass, with three existing skips. Typecheck,
architecture, headless build/check, native builds and deployment checks pass. Both activated
native archives pass checksum/member/privacy checks (26 regular files each); the packaged bundle
matches the headless output. The Electron SQLite binding remains unchanged.

Private execution, probe and health evidence is retained under
`$HOME/.agent-deck/diagnostics/feishu-pending-depth-repair/`. No configuration, credentials,
private host identifiers or message bodies are included here.

## Final status and handoff

The source repair and managed activation are complete. The original approval card was delivered,
but its native operation later timed out after 30 minutes without approval. The owner's later
offline/reconnected check confirms the old presentation is expired; Core has no pending request
or successful creation. A fresh owner request and approval are needed for the remaining named
work acceptance. Do not reinstall Desktop or automatically repeat work creation. The older
warm-channel stall remains a separate, unproven incident.

[Change](../../changelogs/recent-3-days/CHANGELOG_664_feishu-native-approval-depth.md)
[Review](../../reviews/recent-3-days/REVIEW_305_feishu-native-approval-depth.md)
