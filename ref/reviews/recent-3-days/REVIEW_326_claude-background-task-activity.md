---
review_id: 326
reviewed_at: 2026-10-14
baseline_commit: 7b1ff2bd9e3a7c463bac266b6f3d507483035b63
expired: false
---

# Claude background task activity and tool pairing

## Scope and method

Owner screenshots report a Claude execution diagnostic when entering input around background
work, missing background task activity, and separate Bash start/completion rows. The owner
confirmed that these are Local sessions on another computer. Its installed build and raw SDK
frames were unavailable; the local database contained no matching Claude error event. The
findings below are reproduced application defects, not proof of that machine's complete sequence.

Source tracing used the installed Claude Agent SDK 0.3.299 declarations, deterministic SDK-frame
tests, IPC tests, and renderer tests. No live model call, independent paired review, application
restart, or replacement was performed for this fix. The preceding handoff release installation
completed successfully before this task began.

The review-expiry helper exited while listing an existing historical scope. A direct per-file
baseline/churn/commit/age audit classified eight files as unreviewed, three as expired, and seven
as covered. All eighteen files were inspected regardless of earlier coverage.

```review-scope
src/contracts/session-events.test.ts
src/contracts/session-events.ts
src/main/adapters/claude-code/sdk-bridge/background-tasks-core.test.ts
src/main/adapters/claude-code/sdk-bridge/background-tasks-core.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.test.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor-core.test.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/user-message-acceptance-core.ts
src/main/ipc/__tests__/sessions-file-changes.test.ts
src/main/ipc/sessions.ts
src/main/session/__tests__/manager-helpers.test.ts
src/renderer/components/activity-feed/background-task-presentation.test.tsx
src/renderer/components/activity-feed/background-task-presentation.ts
src/renderer/components/activity-feed/records-view.tsx
src/renderer/components/activity-feed/rows/background-task-row.tsx
src/renderer/components/activity-feed/tool-file-change-presentation.test.tsx
src/shared/background-task.ts
```

## Findings and fixes landed

1. MEDIUM: foreground ownership was set only when application input entered the SDK. A turn
   automatically started by a task result could emit assistant output while that flag remained
   false. A correction then lacked the evidence required by the existing narrow interruption
   classifier. Top-level assistant response starts now establish foreground ownership, including
   streaming message starts. Child responses, pings, and background lifecycle frames do not.
   The exact diagnostic, compatible terminal reason, and pending later-input checks remain;
   ordinary provider failures and failures belonging to the correction itself stay errors.
2. MEDIUM: the translator ignored `task_started`, `task_progress`, `task_updated`,
   `task_notification`, and `background_tasks_changed`. These now produce bounded, durable
   `background-task` snapshots through the existing Local/Remote event transport. The feed keeps
   one row per task, preserving description, progress, usage, terminal outcome, summary, and output
   file reference. Details stay mounted during updates. Background state does not complete,
   interrupt, or activate the main conversation.
3. MEDIUM: Local event history left `agentId` empty, while live completions carried the adapter
   identity. Tool pairing includes that identity, so a history-loaded start and live completion
   could never join. Local IPC now hydrates the session's adapter. The view also hydrates missing
   identities for its own session's existing cached rows, preserving explicit adapter and session
   boundaries. It does not guess associations from tool names or timestamps.

Task state follows the SDK's native run ordering. Late progress cannot revive a terminal run,
older runs cannot overwrite resumed runs, and repeated snapshots do not duplicate rows. Membership
removal yields an unknown outcome until a terminal event arrives, rather than inventing success.
Ambient/hidden tasks stay out of the inline feed, including visibility changes after registration.
Process restart/end boundaries prevent old history from claiming a task is still running. Retained
terminal state is bounded; live task identities remain available for future updates.

## Validation and evidence

- Before the repairs, both automatic-turn correction tests reproduced the exact diagnostic;
  the history/live Bash test rendered two rows instead of one. All three pass after repair.
- `pnpm typecheck` passed architecture checks and both TypeScript projects.
- Full `pnpm test`: 7,295 tests passed, 6 skipped; 1,160 files passed and 3 skipped.
- Final focused validation: 103 tests passed across nine files, including the final malformed
  payload guard, lifecycle ordering, native run changes, hidden tasks, foreground isolation,
  history/live pairing, Remote event contracts, and real-error preservation.
- `pnpm build` passed. Existing dependency/bundler and test-DOM KaTeX warnings remain.
- Whitespace, changed-file privacy, and source-size checks passed; all changed files are below
  500 lines. The review bucket scan required no record moves.

## Residual risk and activation

- The affected computer still needs an updated application and main-process restart. Its live
  scenario has not been replayed here, and unrelated upstream execution failures remain possible.
  Existing error history is preserved. No installed app or running session was changed by this fix.
- Background task rows depend on native SDK events and the activity history currently loaded.
  Older runtimes that emit no task events cannot provide these states. This is an activity view,
  not a new control API for stopping jobs or reading arbitrary output files.
- SDK progress metrics are display metadata; they do not enter authoritative token accounting.
  Native task state lives with its provider process and does not grant another session authority.
- Packaging, installation, and verification on the affected computer remain separate release work.
