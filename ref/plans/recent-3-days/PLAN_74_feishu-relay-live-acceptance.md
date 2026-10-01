---
plan_id: 74
completed_at: 2026-09-30
status: completed
---

# Feishu Relay private-chat acceptance

## Goal and constraints

Connect the owner's personal-tenant Agent Deck bot to the managed Relay and verify actual commands,
native approval and provider replies. Preserve pairing, credentials, native runtime controls,
assistant history and the separate work-session selection. This record closes the original live
acceptance and event-compatibility plans; later naming/UI follow-ups retain their own active plans.

## Completed integration

- Published the bot for the intended owner with the project icon, long-connection message and card
  callbacks, and the explicitly approved narrow reaction permission. Owner pairing is preserved.
- Repaired empty-token/nullable optional metadata, bundled WebSocket frame masking, terminal Core
  transport retirement and actual persisted reply delivery. Storage budgeting and bounded runtime
  retention protect active/fallback releases and user data. Details remain in
  [REVIEW_297](../../reviews/recent-3-days/REVIEW_297_feishu-event-metadata.md).
- The owner accepted help/directories, natural read-only management, ordinary assistant replies,
  retained test-word history, the requested assistant persona, work replies and real task approval.
- Latest activation: accepted Desktop/Worker 3ea and managed Server/Feishu d4d0d0b4. Installed app,
  unique formal GUI, Worker/supervisor, Relay and Feishu/Core health have independent evidence.
  The native approval-depth correction is recorded in
  [PLAN_73](PLAN_73_feishu-native-approval-activation.md).

## Latest real business acceptance

The owner sent a fresh natural-language request after an earlier offline approval expired, approved
the new native creation card, and supplied the successful result screenshot:

- The card becomes approved without action buttons.
- The assistant creates the task-derived name "飞书连接验证" using saved Codex astra/medium,
  native Gateway, never approval and Workspace sandbox.
- The actual work provider replies "连接正常。" in a card headed by that name, with the canonical
  session ID in the footer. Ordinary assistant messages remain separate plain replies.
- The original input shows the completion reaction.

Read-only Core verification corroborates completed create_work_session, separate assistant/work
identities, both turns finished and zero pending approvals. The new work history has no tool calls.
The assistant remains Codex luna/max/native/on-request/Workspace. No model or policy was changed,
no duplicate test work was created, and no approval was submitted on the owner's behalf.

## Validation and evidence

The latest source repair passed nine focused and 6,892 full-suite tests, with three existing skips,
plus typecheck, architecture, headless/native builds and deployment checks. Both activated native
archives were audited. This closeout changes documentation only and needs no new package or restart.
Sanitized live evidence and snapshots of the two completed working plans remain private under
`$HOME/.agent-deck/diagnostics/feishu-pending-depth-repair/`.

## Final status and remaining scope

Owner pairing, private commands, native approval and real assistant/work provider delivery are
accepted. Explicit manual rename followed by a named /send remains an additional owner check;
it is not claimed by this screenshot. Clearer expired-card guidance and the separately unproven
older warm-channel stall remain in the active conversational/input plans. Do not reinstall,
re-pair or repeat successful creation/approval tests to close those follow-ups.

## Follow-on owner inspection

The owner can see the new work through Remote Desktop, but opening its detail triggers repeated
SSH bridge exit/reconnect; that separate defect is under active investigation. The owner also
rejects the assistant-parent/work-child hierarchy written by the current creation implementation.
Independent owner-work registration and the detail failure are tracked in the active repair plan;
the successful Feishu provider/approval acceptance above does not claim those issues are fixed.

A separate capability audit ran 55 existing tests successfully. Creation carries an existing
Workspace-relative directory through to the provider cwd; /new currently uses the root. Directory
suggestions are not a filesystem browser. Session deletion is distinct from filesystem deletion;
no dedicated Workspace file/folder deletion API or Feishu command exists in this release.
