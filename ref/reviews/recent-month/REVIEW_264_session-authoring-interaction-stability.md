---
review_id: 264
reviewed_at: 2026-08-24
baseline_commit: a5f383738a0cb0d088925b86a6562b7bc5f7eb44
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final review/changelog records and indexes are mechanical evidence added after implementation."
---

# REVIEW_264_session-authoring-interaction-stability: Review session authoring and History interactions

## Scope and method

This review traced Local and Remote session-creation trust projections through the shared 150 ms
presentation policy, followed History actions to their existing Local IPC and Remote capability
boundaries, and compared compact versus expanded composer attachment ownership. It also reproduced
the reported transition in a Browser visual fixture, inspected the expanded overlay, ran focused
regressions, and completed the repository validation workflow. The file-level review-expiry script
was run before finalizing this record.

```review-scope
README.md
src/renderer/components/HistoryPanel.tsx
src/renderer/components/HistorySessionActionsMenu.tsx
src/renderer/components/LocalHistorySummaryCard.tsx
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/RemoteSessionSummaryCard.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/SessionDetail/SessionComposerView.tsx
src/renderer/components/SessionDetail/__tests__/ComposerInputAttachments.test.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/SessionDetail/composer-sdk/ComposerInput.tsx
src/renderer/components/SessionDetail/composer-sdk/ExpandedComposerOverlay.tsx
src/renderer/components/__tests__/HistoryPanel.parity.test.tsx
src/renderer/components/__tests__/HistoryPanel.readiness.test.tsx
src/renderer/components/__tests__/NewSessionDialog.readiness.test.tsx
src/renderer/components/issues/RemoteIssueResolutionDialog.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/hooks/useSessionCreationOptions.ts
src/renderer/remote-host/RemoteDialogs.test.tsx
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | After a slow adapter switch crossed 150 ms, Local creation rendered the unresolved trust sentinel as the final “无法确认” note. A trusted response then removed it shortly afterward, producing a white-tinted flash and a second height contraction. | Separate request-safe trust from presentable trust. Retain a settled same-adapter descriptor, expose no fabricated descriptor for a new adapter, and disable retained consent while the exact trust revision is pending. |
| MEDIUM | The expanded composer could display and remove existing attachments but had no file picker, even when Codex advertised image input and the compact composer exposed one. | Pass the same attachment capability, MIME list, and `useImageAttachments` add callback into the overlay and render an expanded image action backed by the same queue. |
| MEDIUM | The full-screen expanded composer did not declare `no-drag`; its header overlapped the app's native drag strip, so close clicks and double-clicks could be interpreted as window movement/maximization. | Mark the entire overlay as `no-drag`; retain the existing focus trap and explicit close action. |
| LOW | Local and Remote reactivation backends plus a shared menu item already existed, but History panels never supplied the action. Remote card menus also required unrelated history-write callbacks before rendering. | Wire closed, unarchived History rows to the existing lifecycle action and let Remote reactivation be capability-gated independently. |

## Visual evidence

- Before the trust fix, the 220 ms adapter fixture recorded approximately `412 → 397 → 357 px`:
  the middle frame contained both the unavailable-trust note and update progress for about 70 ms.
- After the fix, the same fixture recorded `412 → 357 px`; every sampled frame reported the
  unavailable-trust note absent, while the slow path still exposed the shared progress state at the
  150 ms boundary.
- The expanded-composer snapshot visibly contained `添加图片` and `关闭`. DOM inspection found a
  48 × 23 px close control and `no-drag` on the full dialog; clicking close removed the dialog.

## Validation

- Focused tests passed: 7 files / 66 tests.
- `pnpm typecheck` passed architecture, Core Node, and both TypeScript configurations.
- `pnpm test` passed 1,007 files and 6,314 tests; 2 files and 3 opt-in tests were skipped.
- `pnpm build` completed Main, Preload, Renderer, and build-info output.
- `pnpm logger:check` passed.
- Browser verification used session-private Local tabs only; all tabs and temporary fixtures were
  closed or removed afterward.
- `git diff --check` passed.

## Residual risk

- Browser inspection proves Chromium layout, action visibility, click handling, and the emitted
  `no-drag` contract. A packaged Electron acceptance remains the final proof against macOS native
  title-bar double-click behavior; installing/restarting the host app was intentionally not done
  from the active in-app session.
- Reactivation intentionally remains orthogonal to archive state. An archived closed row must first
  be unarchived so reactivation cannot create an active-but-still-hidden session.

## Verdict

PASS. All four reported interaction gaps are addressed, with no open CRITICAL, HIGH, MEDIUM, or
LOW finding in the reviewed scope.
