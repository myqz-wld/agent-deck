---
plan_id: 79
completed_at: 2026-09-30
status: completed
---

# Feishu rich-text activation and follow-up closure

## Goal and constraints

Repair literal Markdown in ordinary Feishu assistant replies while retaining the owner's choice
of plain conversation without source labels. Work and approval replies keep cards. The optional
format preference received no response; the recommended automatic text/post choice was explicitly
announced before implementation. No new prompt, model, sandbox, approval policy or schema change.

The same managed Relay Server and Feishu activation was already authorized. Desktop and Worker
remain on the accepted 51e57942 release; no application was packaged, stopped or replaced.
The owner sends test messages and submits approvals. No test was sent on the owner's behalf.

## Source and validation

Source release: `33b9e7888145a1506b6cf2f93af1fa3eb90ee33a`, merged and pushed to main. Main's
independently committed Pending-question work is preserved. See
[CHANGELOG_669](../../changelogs/recent-3-days/CHANGELOG_669_feishu-markdown-replies.md) and
[REVIEW_310](../../reviews/recent-3-days/REVIEW_310_feishu-markdown-replies.md).

Integrated validation passes 6,968 tests with six existing skips, including 53 focused formatting
and delivery regressions. Types, architecture, reproducible headless build, both native builds,
headless/deployment checks and artifact privacy checks pass. The Electron SQLite binding is
unchanged. Both archives contain 26 regular members and the exact built Feishu bundle.

## Managed activation

Official Server check, dry-run, upgrade and verify completed successfully. The returned release
commit matches the source above. One official Feishu upgrade and verify activated arm64 runtime
`2ec4ababd559203f42611e0b4e8d540ea7ecc1d8caaca517cac72cddc84b8f0e`.
Its active and desired digests match, no update is pending, and platform/Core connections are
healthy. The official upgrade's rebuilt artifacts reproduce the audited digest.

The installed Desktop remains `51e57942356b686975aaec25b50b743eac516617` with ASAR
`9407f89adc2016c3678924a2bc17aa2eaf6f91a5180d3df15f16ec24966d2862`; independent process inspection
found exactly one formal GUI. No re-pairing, model selection or Worker replacement was performed.

Private lifecycle status, logs, validation and artifact evidence remain under
`$HOME/.agent-deck/diagnostics/feishu-markdown-replies/`. A completed status must be checked before
any recovery; do not repeat completed upgrades. The previous b3 activation retains its own final
status and evidence in feishu-final-followups.

## Accepted business behavior and plan consolidation

The original conversational-bot, natural-management and input/approval plans are consolidated into
their delivered records instead of leaving contradictory historical next steps active:

- Natural named work creation, real approval terminal cards, independent assistant history and
  progress reactions: [PLAN_74](PLAN_74_feishu-relay-live-acceptance.md).
- Stable Remote detail and independent work hierarchy: [PLAN_76](PLAN_76_remote-worker-activation.md).
- Manual rename/named send, specified-directory work creation with actual pwd, and native deletion
  of only the disposable file/folder: [PLAN_78](PLAN_78_feishu-operations-approval-activation.md).
- Refined voice and retained test-word reply were observed from the same assistant after version 2
  setup. Existing history, saved runtime choices, work session and empty workdir remain intact.

Native file deletion is accepted for the current Codex assistant with its existing controls;
this does not promise identical native tools or approval behavior for every adapter. Private
snapshots preserve the superseded working-plan history before cleanup.

The official worktree exit restored main and removed the owned worktree. Its merged local
feature branch is deleted; no remote feature branch was created. Temporary manifest/audit inputs
and superseded working plans are removed, while private evidence and unrelated files remain.

## Remaining owner feedback

An exact harmless prompt requests a real ordinary reply with emphasis, list, code, table and a
synthetic local-path link. Client display remains unverified until the owner reports the result;
automated payload validation and runtime activation are complete. A concise active follow-up plan
retains this check rather than claiming all visual acceptance is finished.

The old expired-card toast remains optional feedback. The earlier no-reply investigation is
explicitly deferred by the owner, with evidence preserved and no claim of a source repair. No
successful personal-task, pairing, creation or deletion test needs repeating.
