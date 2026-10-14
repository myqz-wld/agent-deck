---
review_id: 325
reviewed_at: 2026-10-14
baseline_commit: 6b7a44da1a36d72d236aa1950fc1e10a558f5a10
expired: false
---

# Handoff state across dialog dismissal

## Scope and method

Lead debugging and regression validation of Local and Remote handoff dialogs. No independent
reviewers or live process actions were involved. The review-expiry helper exited with status 1
while listing existing historical scopes; a direct per-file scope, baseline, diff, and history
scan covered every changed file below. All listed files were inspected regardless of prior coverage.

```review-scope
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.fixture.ts
src/renderer/components/SessionDetail/RemoteHandOffDialog.test.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.persistence.test.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.tsx
src/renderer/components/SessionDetail/RemoteSessionComposer.test.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.a11y.test.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.persistence.test.tsx
src/renderer/components/hand-off/HandOffDialogFrame.tsx
src/renderer/components/hand-off/local-draft.ts
src/renderer/components/hand-off/remote-draft.ts
src/renderer/components/new-session/useRemoteSessionCreation.ts
```

## Findings and fixes landed

1. MEDIUM: Local dismissal cancelled the preparation and reset the form on reopening. Both
   dialogs discarded pending results when their view unmounted. Session-scoped renderer stores
   now own instructions, target selections, preparation/commit progress, previews, and failures.
   Closing and session navigation leave that work intact. Remote drafts additionally bind to
   the exact source identity. Reopened views subscribe to the same operation and cannot submit
   duplicate prepares or commits; completion reaches the current view instead of a stale callback.
2. LOW: Remote's generic busy flag disabled the handoff entry during background preparation.
   The current handoff can now reopen while its operation is pending; another session's operation
   does not enable that entry.

The shared frame distinguishes temporary dismissal from explicitly abandoning a completed
preparation. Explicit abandonment and edits release Local cached preparations; regeneration waits
for earlier cancellation to finish. Failed-successor cleanup acknowledgement remains mandatory
across navigation. Remote capability reads revalidate restored choices and invalidate previews
whose effective target changes. Local configuration-read errors remain scoped to their read.

## Validation and evidence

- `pnpm typecheck`: architecture checks and both TypeScript projects passed.
- Focused dialog, accessibility, and composer suite: 46 tests passed across six files.
- `pnpm test`: 7,267 passed and 6 skipped; 1,158 passing and 3 skipped files.
- `pnpm build`: passed; existing dependency/bundler warnings remain.
- Regression coverage includes pending and completed preparation across actual unmount/remount,
  close/reopen through the same parent, source/session separation, configuration and instruction
  restoration, background failure/retry, expired Local preparation, explicit abandonment,
  capability changes, disconnect fencing, duplicate-commit prevention, late cleanup failure,
  current-view completion, and reopening from the Remote composer while busy.
- Whitespace, changed-file privacy, and source-file size checks passed. Changed source and test
  files remain below 500 lines. The review bucket scan required no record moves.

## Residual risk and follow-ups

- Drafts live in renderer memory. Application restart or renderer reload is outside this fix's
  restoration guarantee; no conversation content is newly written to browser storage.
- Local preparations retain the existing main-process cache lifetime and freshness checks.
  An expired preparation is rejected and cleared at commit while editable fields remain available
  for regeneration. Remote binding checks remain authoritative at commit.
- Committing retains its existing modal dismissal guard. Navigation cannot duplicate the operation
  or lose its terminal result. No main/preload changes or restart are required for development HMR.
- Production installation and live Browser verification were not performed.
