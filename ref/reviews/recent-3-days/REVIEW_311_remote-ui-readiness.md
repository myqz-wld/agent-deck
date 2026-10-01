---
review_id: 311
reviewed_at: 2026-10-01
baseline_commit: aa948431d63dc1bd944e4ef6196157cb503e20be
expired: false
---

# Remote UI readiness and cache lifecycle audit

## Scope

Bounded source inspection and regression validation of the owner's Remote UI request. This is a
local engineering audit, not an independent paired review. Review-expiry analysis was run;
unrelated expired or unknown coverage remains outside this delivery and receives no exemption.

```review-scope
src/renderer/AppWorkspace.tsx
src/renderer/components/AssetsLibraryDialog.test.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/DataPanel.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/PendingTab.tsx
src/renderer/components/SessionDetail/RemoteDiffPanel.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/use-file-change-pages.ts
src/renderer/components/SessionDetail/use-file-change-payload.ts
src/renderer/components/SettingsDialog.readiness.test.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/assets/RemoteApplicationConventionTab.test.tsx
src/renderer/components/assets/RemoteApplicationConventionTab.tsx
src/renderer/components/data-panel/DataPanelView.readiness.test.tsx
src/renderer/components/data-panel/DataPanelView.tsx
src/renderer/components/data-panel/ProviderUsageReset.tsx
src/renderer/components/issues/RemoteIssuesPanel.tsx
src/renderer/components/settings/FeishuPreferenceEditor.tsx
src/renderer/components/settings/FeishuPreferencesSection.test.tsx
src/renderer/components/settings/FeishuPreferencesSection.tsx
src/renderer/components/settings/ProviderModelThinkingFields.tsx
src/renderer/components/settings/feishu-preferences-data.ts
src/renderer/components/settings/use-settings-dialog-read.ts
src/renderer/hooks/useDelayedAsyncFallback.ts
src/renderer/remote-host/remote-session-detail-cache.ts
src/renderer/remote-host/use-remote-event-records.ts
src/renderer/remote-host/use-remote-session-source-detail.test.tsx
src/renderer/remote-host/use-remote-session-source.ts
src/renderer/remote-host/use-remote-session-tab-data.test.tsx
src/renderer/remote-host/use-remote-session-tab-data.ts
src/renderer/remote-host/use-remote-task-records.ts
src/renderer/remote-host/use-remote-usage-source.ts
src/shared/remote-read-cache.test.ts
src/shared/remote-read-cache.ts
vitest-setup.ts
```

## Findings and fixes landed

1. Settings, assets and details lost read projections on revisit; the settings gate finished
   before remote dependencies, causing repeated loading copy. Complete settings now share one
   150 ms initial gate. Bounded caches retain matching projections and revalidate mutable data.
2. Manual assistant save/refresh and separate runtime rows created excessive spacing. A single
   form saves selections automatically and commits model text on blur/Enter. Writes serialize
   and coalesce with revision/authority checks; late replies preserve newer drafts. Reopening
   waits for already-requested saves, and failed drafts support explicit reconciled retry.
3. Quota refresh immediately displayed progress, replaced known totals and removed the reset
   control. Progress now waits 150 ms; totals and the disabled reset control remain visible.
   The explicit refresh button is preserved as requested, and checks consumed no credit.
4. Cache introduction exposed lifecycle hazards: a retired catalog read could survive reconnect,
   an unmounted message read could replace newer cached data, and a settings reread could undo
   a local appearance edit. Invalidation epochs, request/mount fencing and mutation epochs
   cover these races. Cached session metadata does not restore runtime/input authority.

## Audit coverage and evidence

| Surface | Result |
| --- | --- |
| Settings / assistant | Compact autosave form, complete initial gate, warm revalidation |
| Assets / conventions | Retained catalogs and revision-qualified adapter documents |
| Live / History / Pending | Existing mounted/source-owned retention and grace verified |
| Issues / other dialogs / new session | Existing source isolation and readiness tests pass |
| Usage | Delayed feedback; retained totals and refresh/reset controls |
| Session detail | Cached display with fresh authority; bounded tasks/events/messages/diffs |

Final checks passed: pnpm typecheck (architecture and both TypeScript projects), pnpm test
(1,130 files / 6,989 tests passed, three files / six existing test skips), and pnpm build.
New tests exercise cache bounds/expiry, read retirement, source isolation, cold and warm settings,
autosave ordering/recovery, and quota refresh continuity. Existing Remote parity/readiness,
new-session, list, issue, session, diff and quota tests passed in the integrated run.

Browser inspection used the real assistant component and compiled CSS with mock APIs. It confirmed
grouped runtime controls, compact spacing and absent normal save/refresh buttons. A synthetic
Gateway selection resolved its model/thinking and saved once. The private tab was closed. This
check is not a live network latency benchmark or deployment check.

## Residual risk and follow-ups

Cached projections may briefly show earlier content while revalidation finishes. They remain
memory-only, bounded and source-qualified. Runtime/input permissions are freshly read before
session actions; preference saves retain compare-and-set authority/revision checks. Remote
requests can still exceed 150 ms; that threshold controls presentation, not transport speed.
Quota consumption retains its normal user confirmation.

All changed source/tests stay within 500 lines. No installed runtime or remote service was
restarted or replaced. Activation follows the existing renderer development/release workflow.
No required in-scope follow-up remains.
