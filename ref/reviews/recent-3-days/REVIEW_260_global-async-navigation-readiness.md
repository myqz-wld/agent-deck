---
review_id: 260
reviewed_at: 2026-08-21
baseline_commit: ceb4c63e9b6ba69e44c826c492e2b073f90de90b
related_changelog: CHANGELOG_623
expired: false
---

# REVIEW_260_global-async-navigation-readiness: Global 150 ms navigation audit

## Scope and method

This local audit followed every top-level application destination, Remote detail entry, Session
Detail data tab, Settings/Assets entry, and application-convention adapter switch. It separated
incomplete initial navigation projections from explicit user-started operations whose progress must
remain immediate. The user explicitly declined an independent paired review, so no reviewer agents
were used.

```review-scope
src/renderer/App.tsx
src/renderer/AppWorkspace.tsx
src/renderer/AppWorkspace.remote-parity.test.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/AssetsLibraryTabButton.tsx
src/renderer/components/DialogInitialReadiness.test.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/IssueDetail.tsx
src/renderer/components/IssuesPanel.tsx
src/renderer/components/PendingTab.tsx
src/renderer/components/RemotePendingTab.tsx
src/renderer/components/SessionDetail/MessagesPanel.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/TasksPanel.tsx
src/renderer/components/SessionDetail/async-panel-readiness.test.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/SummaryView.tsx
src/renderer/components/__tests__/HistoryPanel.readiness.test.tsx
src/renderer/components/__tests__/IssuesPanel.membership.test.tsx
src/renderer/components/__tests__/PendingTab.forms.test.tsx
src/renderer/components/__tests__/PendingTab.readiness.test.tsx
src/renderer/components/activity-feed/records-view.tsx
src/renderer/components/assets/RemoteApplicationConventionTab.tsx
src/renderer/components/assets/RemoteApplicationConventionTab.test.tsx
src/renderer/components/issues/IssueBoard.tsx
src/renderer/components/issues/RemoteIssuesPanel.tsx
src/renderer/components/settings/b18/ConventionDocumentEditor.tsx
src/renderer/components/settings/remote-settings-availability.ts
src/renderer/hooks/use-local-app-bridges.ts
src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx
src/renderer/remote-host/RemoteDialogs.test.tsx
src/renderer/remote-host/RemoteIssuesPanel.test.tsx
src/renderer/remote-host/remote-dialogs-test-fixture.ts
src/renderer/remote-host/session-detail-source-shell-test-fixture.ts
src/renderer/remote-host/source-types.ts
src/renderer/remote-host/use-remote-presentation-lists.test.tsx
src/renderer/remote-host/use-remote-presentation-lists.ts
src/renderer/remote-host/use-remote-session-source.ts
src/renderer/stores/__tests__/session-store.test.ts
src/renderer/stores/session-store-state.ts
src/renderer/stores/session-store.ts
```

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Local History rendered a false empty state, then immediate loading, then rows; every refresh also replaced settled rows. | Add explicit initial readiness, delayed fallback, offscreen preloading, stale-row retention, inert interaction, and fixed-slot refresh status. |
| MEDIUM | Issues and Pending had the same unresolved-empty ambiguity; Local pending also advertised zero before its startup snapshot settled. | Add Local/Remote initialized state, persistent destinations, delayed fallbacks, stable refresh presentation, and header unknown-count handling. |
| MEDIUM | Remote detail entry and nested activity/tasks/summary/messages reads immediately replaced complete navigation with temporary loaders. | Retain the Remote list for the fast window and delay all nested initial loaders through the shared boundary. |
| MEDIUM | Settings, Assets, Issue detail, and application-convention reads remained outside the shared readiness policy; Remote adapter switches discarded the previous document immediately. | Gate initial reads and retain the settled Remote adapter projection through 149 ms. |
| LOW | Read refresh errors and progress could add or remove layout rows, and the expanded implementation pushed existing large files over the size guard. | Use reserved status slots and extract three focused modules. |

## Global disposition

- `Live`: existing Local store and Remote presentation streams are continuously populated; Remote
  detail selection now retains the list during its fast read.
- `Pending`: Local and Remote initial snapshots are identity-safe and delayed; settled buckets remain
  mounted.
- `History`: Local preloads offscreen; Local/Remote initial, empty, refresh, and error states are
  distinct.
- `Issues`: Local/Remote lists preload offscreen and retain settled rows through refresh.
- `Data`: the Local preload and Remote `DataPanelView` already render a fixed multi-section shell with
  unavailable values as `—`; no whole-page temporary projection is mounted.
- Explicit load-more, diff/file selection, image, log, and directory operations retain immediate
  progress because the user has already requested the operation and needs feedback.

## Validation and evidence

- Timing tests cover absence at 149 ms, appearance at 150 ms, fast direct commit, retained prior
  workspace, inert interaction, stable refresh rows, Remote detail entry, and Remote adapter switches.
- Complete `pnpm test` passed 1,001 files and 6,262 tests; 2 files and 3 opt-in tests were skipped.
- `pnpm typecheck`, production `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- The review-expiry report was run before finalization. Its legacy `scope_unknown` inventory does not
  change the bounded UI-readiness scope requested here.

## Residual risk

- The 150 ms value remains a renderer presentation boundary, not an IPC/network deadline. A blocked
  renderer cannot paint exactly at the threshold.
- Different completed destinations may legitimately have different final geometry. The fix removes
  transient incomplete states; it does not force unrelated pages into identical layouts.
- Installed-app visual acceptance requires a later package/restart because replacing the running app
  would terminate this session.

## Verdict

PASS. No open CRITICAL, HIGH, MEDIUM, or LOW finding remains in the audited asynchronous navigation
scope.
