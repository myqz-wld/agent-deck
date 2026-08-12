---
review_id: 154
reviewed_at: 2026-07-12
baseline_commit: be6781ec623a3edf7b6fa50dd1aa8847cc7efe29
expired: false
skipped_expired: []
---

# REVIEW_154_core-snapshot-ui-copy: Core snapshot integrity and concise UI copy

## Scope and method

This solo, risk-based review covered core renderer synchronization, session focus, failure handling,
settings accuracy, and user-facing renderer/CLI copy. Per the user's instruction, no `simple-review`,
`deep-review`, reviewer agent, or discovery agent was used. The audit revalidated seven retained
candidates against the current baseline, then extended the same race analysis to summary snapshots
and consecutive focus requests.

The copy pass followed `UI_COPY_LANGUAGE.md`: surrounding prose stays natural Simplified Chinese,
while established product and protocol terms remain unchanged. Paired Claude/Codex prompt assets
were compared under the prompt-asset workflow; their current hashes matched the fresh inventory and
their wait, hand-off, permission, and `list_session_events` semantics were aligned, so no prompt asset
was changed.

```review-scope
resources/bin/agent-deck
resources/bin/agent-deck-version.ps1
resources/bin/agent-deck.cmd
src/main/__tests__/session-focus-request.test.ts
src/main/index/bootstrap-wiring.ts
src/main/ipc/__tests__/sessions-pin.test.ts
src/main/ipc/sessions.ts
src/main/session-focus-request.ts
src/preload/api/sessions.ts
src/renderer/App.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/DataPanel.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/IssueDetail.tsx
src/renderer/components/IssuesPanel.tsx
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/PendingTab.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/SessionCard.tsx
src/renderer/components/SessionList.tsx
src/renderer/components/SessionModelFields.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/SummaryView.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/__tests__/SummaryView.test.tsx
src/renderer/components/activity-feed/index.tsx
src/renderer/components/assets/AssetCard.tsx
src/renderer/components/settings/controls.tsx
src/renderer/components/settings/sections/AgentDeckMcpSection.tsx
src/renderer/components/settings/sections/ContinuationContextSection.tsx
src/renderer/components/settings/sections/ExperimentalSection.tsx
src/renderer/components/settings/sections/KeyboardShortcutsSection.tsx
src/renderer/components/settings/sections/LifecycleSection.tsx
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/__tests__/AgentDeckMcpSection.test.tsx
src/renderer/components/settings/sections/__tests__/ContinuationContextSection.test.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/renderer/hooks/use-event-bridge.ts
src/renderer/lib/__tests__/load-stable-snapshot.test.ts
src/renderer/lib/error-message.ts
src/renderer/lib/load-stable-snapshot.ts
src/renderer/main.tsx
src/renderer/stores/__tests__/session-store.test.ts
src/renderer/stores/session-store-maps.ts
src/renderer/stores/session-store-rename.ts
src/renderer/stores/session-store-revisions.ts
src/renderer/stores/session-store.ts
src/shared/ipc-channels.ts
```

## Verdict

**PASS after fixes.** Final finding distribution:

- CRITICAL: 0
- HIGH: 1 fixed
- MEDIUM: 4 fixed
- LOW: 3 fixed

## Findings

### HIGH-1 fixed — stale pending snapshots could hide or revive a user request

At the baseline, `activity-feed/index.tsx:62-80` replaced a session's pending buckets after an
unversioned IPC read, while `App.tsx:85-97` merged adapter-wide snapshots one adapter at a time. A
live request arriving after snapshot capture could be erased; a cancellation arriving in the same
window could be undone by the late merge. In the first case the provider remains blocked but the UI
no longer exposes the response controls.

The fix adds per-session live revisions and a shared stable-snapshot loader. Per-session and global
pending reads now retry when their live revision changes; only a stable adapter-wide aggregate may
replace the complete pending state, which also clears stale HMR state without reviving resolved work.

### MEDIUM-1 fixed — the initial session snapshot could overwrite newer live state

`use-event-bridge.ts:16-51` subscribed before loading but still called full `setSessions` with a
potentially older response. A same-id `session-upserted`, removal, or rename received during the IPC
window could therefore be reverted. Session mutations now advance a store revision; late snapshots
are discarded and retried before the full replacement/prune is allowed.

### MEDIUM-2 fixed — event and summary snapshots could erase newly pushed entries

`activity-feed/index.tsx:62-68` and `SummaryView.tsx:18-25` performed full list replacement without
coordinating with `agent-event` or `summary-added` pushes. Both domains now have per-session live
revisions and use the stable-snapshot loader. A regression test proves a stale summary response is
rejected, reloaded, and cannot replace the newly pushed summary.

### MEDIUM-3 fixed — cold or consecutive focus requests were lossy

`App.tsx:134-143` only listened for the ephemeral `session-focus-request` event and explicitly
accepted the cold-start gap. Main now retains the latest focus target until a typed IPC atomically
consumes it. Renderer setup subscribes first, then consumes the retained value, and a request
sequence prevents an older asynchronous consume from winning over a newer focus event.

### MEDIUM-4 fixed — routine IPC failures could escalate into the global fatal overlay

Several fire-and-forget renderer calls had no rejection path, including baseline settings/window
sync, summary loading, history actions, session card actions, asset refresh/reveal, token reads, and
settings pickers. A transient IPC rejection reached the global `unhandledrejection` handler and
could cover the app with a fatal banner. These calls now either show a local actionable error or log
a bounded warning; error rendering also safely handles non-`Error` rejection values.

### LOW-1 fixed — leaving History did not invalidate an in-flight selection

`App.tsx:145-147,257-263` cleared the detail but did not advance its request sequence. A delayed
`getSession` could repopulate the old detail after the user left. Changing away from History now
invalidates every earlier selection response.

### LOW-2 fixed — MCP settings exposed a stale and platform-specific inventory

The settings panel said 18 tools and omitted active `list_session_events`; it also pointed every OS
to the macOS settings path when rotating a leaked Token. The panel now lists and tests all 19 tools,
uses a platform-neutral configuration-directory instruction, and distinguishes the restart-bound
MCP switch from immediately applied recursion limits.

### LOW-3 fixed — visible copy was verbose, mixed-language, or implementation-led

Empty states, dialogs, lifecycle settings, summary/continuation controls, keyboard help, fatal
errors, and version wrappers contained redundant clauses, English status labels, ASCII punctuation,
or internal implementation terms. The pass shortened actions and explanations, retained required
technical identifiers, and standardized the visible prose to concise Simplified Chinese.

## Validation evidence

- `pnpm typecheck`: passed.
- `pnpm test`: 271 test files passed, 1 opt-in live-smoke file skipped; 2,542 tests passed, 1 skipped.
- Focused regression gates passed across snapshot/store, summary, focus IPC, dialogs, and the MCP
  inventory; the final copy-sensitive gate passed 23/23.
- `pnpm build`: main, preload, and renderer production bundles passed.
- `pnpm logger:check`, `bash -n resources/bin/agent-deck`, and `git diff --check`: passed.
- `pnpm dev`: main/preload/renderer development compilation passed and reached Electron launch. The
  development process then exited through the expected single-instance boundary because the
  installed Agent Deck instance carrying this session was active.
- All touched production TypeScript/TSX files remain at or below 500 lines; the largest is
  `session-store.ts` at 499.

## Residual risk

- The stable loader deliberately stops after four continuously invalidated reads and keeps live
  state instead of applying an unsafe snapshot. A long uninterrupted event burst can temporarily
  omit older history until remount/reload, but it cannot erase newer live state.
- PowerShell and Windows batch wrappers were source-reviewed, and the Bash wrapper passed syntax
  validation, but no local `pwsh` or Windows runtime was available for execution testing.
- A second development window could not coexist with the installed app's single-instance lock.
  Runtime window validation therefore remains the normal post-restart smoke, not a completed
  parallel-window test in this session.
- This was a risk-based core audit, not a claim of line-by-line coverage of every source file.

## Follow-ups

No required follow-up remains. If startup history completeness under sustained high-frequency event
streams becomes observable, add a delayed background retry after the bounded stable-snapshot loop.
