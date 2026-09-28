---
review_id: 276
reviewed_at: 2026-09-22
baseline_commit: 0231d07f7a86e752c3af0ebf13f05f993060cd95
expired: false
---

# Stop automatic IAB navigation and preserve dialogs

## Scope and method

Targeted debugging of Browser requests changing the current session or tab and native Browser
views covering DOM dialogs. IAB is selected only through manual navigation. Source tracing and
renderer regressions cover source/session stability, modal ownership, asynchronous presentation
leases, and annotation continuity.

```review-scope
src/renderer/App.tsx
src/renderer/App.browser-show.test.tsx
src/renderer/hooks/use-browser-show.ts
src/renderer/hooks/use-browser-show.test.tsx
src/renderer/components/expandable-content/layer-manager.ts
src/renderer/components/SessionDetail/IabPanel.tsx
src/renderer/components/SessionDetail/IabPanel.test.tsx
src/renderer/components/SessionDetail/IabPanel.modal.test.tsx
src/renderer/components/SessionDetail/index.tsx
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Browser show requests changed the source/session, selected IAB, and forcibly closed application dialogs. | Remove the global Browser navigation listener and automatic IAB tab selection. Handle show acknowledgements only inside an already mounted IAB panel, without navigation or remounting. Closing a dialog cannot replay navigation. |
| MEDIUM | Native Browser views remained presented above DOM dialogs, where CSS stacking and document isolation cannot hide them. | Park the presentation lease when a modal opens, fence late lease responses and placement callbacks, and acquire a fresh lease after the last modal closes even when Browser state is unchanged. Preserve the mounted panel and annotation draft. |

## Validation and evidence

- Focused renderer regressions: 4 files and 16 tests passed.
- App and SessionDetail integration tests confirm that startup and live Browser requests do not
  change Local/Remote source, selected session, current tab, or a session draft. Closing a dialog
  or leaving IAB does not trigger a later automatic jump. Manual IAB selection still presents the
  native view, and repeated show requests refresh it without remounting the panel.
- Additional coverage includes expired and stale requests, owner/tab isolation, an already
  displayed Browser view, nested dialogs, mounting behind a dialog, a late presentation lease,
  and annotation draft preservation through modal suspension.
- `pnpm typecheck` passed architecture checks and both TypeScript configurations.
- Final `pnpm test`: 1,031 files and 6,392 tests passed; 2 files and 3 opt-in tests skipped.
- The SQLite native binding hash remained unchanged across validation.
- Ran `scripts/file-level-review-expiry.sh`; reviewed the changed code without relying on prior
  exemptions. Rebucketed existing review records under the current index policy.
- `git diff --check` passed.

## Residual risk

- Validation used rendered DOM tests and mocked native presentation IPC. Visual acceptance in
  an installed Electron application was not performed.
- Every changed source and test file remains below 500 lines; no split exception is needed.

## Follow-ups

No further source change is required for this defect. Development renderer changes use HMR;
installed applications receive the fix through the normal later build/update workflow. No live
application process or installed bundle was stopped, restarted, or replaced.
