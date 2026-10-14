---
changelog_id: 681
changed_at: 2026-10-14
---

# Unified Compaction and Activity Status Rows

## Summary

Claude, Codex, Grok, and external Hook compaction events now share a light status strip.
The row keeps a stable timeline position through progress and completion, shows only observed
statistics, and expands details on demand. Session-command feedback uses the same light status
surface. Ordinary system messages, including worktree notifications, retain their original
centered gray bubbles.

## Changes

### Compaction evidence and provider integration

- Added a shared compaction snapshot reader, including the retained Claude command-statistics
  format. User and assistant text is never interpreted as a compaction command outcome.
- Claude emits one start for compacting status and attaches structured completion/failure evidence.
- Codex preserves native compaction IDs and gives manual commands a stable operation identity,
  observed duration, optional summary, and neutral interruption outcome.
- Grok advertises ACP session compaction support and handles native IDs, lifecycle states,
  summary replacement and ordered chunks, nullable error/metadata patches, and image attachments.
  Native lifecycle evidence takes precedence over manual-command fallback feedback.
- Streamed summary snapshots reuse their existing message row in storage and the renderer while
  lifecycle edges remain available. No database migration or new IPC channel is required.

### Timeline presentation

- Compaction start/end events render as one row. Session/provider boundaries, repeated operations,
  partial history, same-millisecond revisions, and late summary chunks are handled explicitly.
- Token counts use compact labels with exact values in the disclosure. Durations use readable
  units. A duration can come from provider evidence or an observed start/end interval; token
  counts are never inferred from cumulative billing usage.
- Simple activity events, subagent details, and background tasks share spacing, timestamps, and
  collapsed details. Interruption/cancellation is neutral; genuine failure remains highlighted.
- Structured `sessionCommandStatus` messages such as `/clear` render as command status rows,
  without a system-message heading. Short feedback remains inline; long diagnostics expand on
  demand. Classification requires the system role and a valid marker, preserving ordinary
  conversation text and worktree notification bubbles. Compaction keeps its dedicated row.
- Ordinary system bubbles, interactive approvals, user/assistant messages, and specialized tool
  and diff surfaces keep their established presentation and interaction behavior.
- Live activity and summary consumers use the actual compaction outcome instead of labeling every
  end event as success. Generic turn errors no longer expose redundant internal subtype labels.

## Validation

- `pnpm typecheck`: passed.
- `pnpm build`: passed, including a refreshed build after separating command feedback.
- Final release regression with four workers: **7,355 passed, 6 skipped, 0 failed**.
- After the final command-feedback adjustment, the renderer/activity and compaction-store tests:
  **140 passed, 0 failed**.
- Focused provider, persistence, rendering, and checkpoint-worker regression: **170 passed**.
- The first broad run encountered a checkpoint-worker timeout; the focused run and final full
  regression passed. SQLite's Electron binding checksum remained unchanged.
- Agent Deck Browser verified actual components with synthetic data: completed provider rows,
  expanded statistics, narrow-panel layout, command status rows, other activity rows, and
  preserved worktree system bubbles.
- `git diff --check`: passed.

## Do Not Split Protection

None required. New modules and modified compaction translation/presentation modules remain below
500 lines.

## Notes

- Provider translation was verified with protocol fixtures and a fake ACP process; no real provider
  compaction was triggered for visual validation.
- Audio summary content has a descriptive placeholder; images use the existing event-image path.
- Main-process changes require subsequent authorized development restart or the normal packaged
  update workflow. No running Agent Deck instance was restarted or replaced.
- Concurrent message-recovery work was preserved, including its specialized recovery UI.
- Worktree transitions already emit a UI status notification and separately deliver an internal
  continuation instruction; this change preserves both behaviors.
- The README keeps one concise feature bullet; implementation and validation details stay in
  this record. Commit, push, macOS packaging, and local installation are authorized follow-up
  delivery; stopping the running installed application requires explicit target approval.
- The owner requested complete `.ref/` cleanup. Preview files and raw validation output were
  removed after validation; subsequent release scratch uses a private system temporary directory.
  A completed earlier installation checklist was archived as
  [PLAN_94](../../plans/recent-3-days/PLAN_94_claude-message-installation.md).
- Related plan: [PLAN_93](../../plans/recent-3-days/PLAN_93_unified-compaction-status.md).
