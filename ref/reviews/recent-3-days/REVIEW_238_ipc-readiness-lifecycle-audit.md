---
review_id: 238
reviewed_at: 2026-08-12
baseline_commit: 082f2ef27eb231091dc516f13f739fb11641f9c8
related_changelog: CHANGELOG_598
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review record, changelog, plan archive, and index maintenance are mechanical."
---

# REVIEW_238_ipc-readiness-lifecycle-audit

## Scope and method

This review traced every renderer flow using the 150 ms fast-read convention, modeled initial
load separately from revalidation, and exercised adapter, provider, cwd, dialog, session, source,
and same-identity Remote availability transitions. It also checked that asynchronous filesystem
and IPC operations remain asynchronous; 150 ms is only a renderer presentation boundary.

```review-scope
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/PermissionsView.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/SessionDetail/RemoteEffectivePermissionsView.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionDetail/use-delayed-tab-selection.ts
src/renderer/components/issues/RemoteIssueResolutionDialog.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/components/new-session/useRemoteSessionCreation.ts
src/renderer/hooks/useDelayedAsyncFallback.ts
src/renderer/hooks/useSessionCreationOptions.ts
src/renderer/components/SessionDetail/RemoteEffectivePermissionsView.test.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.test.tsx
src/renderer/components/SessionDetail/__tests__/use-delayed-tab-selection.test.tsx
src/renderer/components/__tests__/NewSessionDialog.readiness.test.tsx
src/renderer/components/__tests__/NewSessionDialog.test.tsx
src/renderer/components/__tests__/PermissionsView.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/new-session/useRemoteSessionCreation.test.tsx
src/renderer/hooks/__tests__/useDelayedAsyncFallback.test.tsx
src/renderer/hooks/__tests__/useSessionCreationOptions.test.tsx
src/renderer/remote-host/NewSessionDialog.remote-attachments.test.tsx
src/renderer/remote-host/SessionDetail.source-shell.test.tsx
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Remote creation, issue resolution, handoff, and permission projections could retain authority or accept an old async completion across a same-identity disconnect/reconnect cycle. | Add an explicit availability-cycle identity, exact capability snapshots, keyed Remote remounts, request generations, and layout-phase invalidation of create/preview/commit sequences. |
| MEDIUM | Local provider/Gateway discovery began inside the form after its initial gate, so a read could “finish” within 150 ms while the visible form was still incomplete. | Prefetch provider catalogs with adapter defaults and include both in the initial readiness decision. |
| MEDIUM | A Remote response with a non-empty default provider caused a second capability request, while an explicit provider override could fail to become authoritative when the server's default differed. | Commit the reconciled provider into the exact resolved request key and preserve only explicit values accepted by the returned schema. |
| MEDIUM | Remote presentation and create authority used one descriptor, causing the complete form to collapse during cwd/adapter refresh or risking submission against an obsolete schema. | Split stable presentation data from exact submission authority; preserve the committed shape, keep cwd authoring available, block closed-schema controls, and disable create until the exact read settles. |
| MEDIUM | Adapter/cwd changes and failed defaults reads could briefly project values derived from the previous identity. | Key Local selections and results by authoring scope/adapter/request and reset failed cwd-derived values to adapter fallbacks plus explicit remembered choices. |
| LOW | The new-session overlay did not exist during the first 150 ms, leaving the underlying surface interactive. | Mount the modal root and focus boundary immediately while deferring only the dialog panel. |
| LOW | Permission refresh errors discarded useful prior data, and initial failures did not offer an in-place recovery path. | Retain the last complete projection on refresh failure and add explicit retry actions to Local and Remote initial errors. |

## Validation and evidence

- Timing coverage proves completion at 149 ms reveals the complete component directly, while the
  loading fallback appears at 150 ms and never replaces a settled same-identity projection during
  revalidation.
- Lifecycle coverage exercises stale adapter/cwd/provider results, dialog reopen, source switch,
  same-identity disconnect/reconnect, stale create completion, stale handoff preview, and Remote
  permission remount behavior.
- The final focused sweep passed 6 files / 43 tests. Additional hook, permission, and source-shell
  coverage was included in the complete suite.
- The first complete-suite attempt encountered three unrelated process/worker timeout flakes under
  load; all three passed alone (3 files / 13 tests). Two subsequent complete runs passed 957 files /
  6,113 tests, with 2 files / 3 explicit cases skipped.
- Node/Web TypeScript checks, architecture/Core-node boundaries, production build,
  `git diff --check`, and the production 500-line limit passed.

## Residual risk

- The 150 ms threshold is a presentation policy, not a latency guarantee; a renderer that is itself
  blocked cannot paint precisely at the boundary.
- Remote capability correctness still depends on the Worker returning an internally coherent
  descriptor. The renderer now rejects stale identity/request results but does not reinterpret
  provider semantics.
- Validation ran against the combined dirty workspace. Unrelated concurrent changes were preserved
  and are not claimed by this review.

## Verdict

PASS. No open CRITICAL, HIGH, MEDIUM, or LOW finding remains in the reviewed readiness and
lifecycle scope.
