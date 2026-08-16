---
review_id: 250
reviewed_at: 2026-08-15
baseline_commit: 828041de3990df8791bebb9a54fa89cc4cd1d863
related_changelog: CHANGELOG_613
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record and index maintenance is mechanical evidence derived from the reviewed tree."
---

# REVIEW_250_interruptible-reconnect-and-session-readiness

## Scope and method

This review traced renderer mutation serialization, explicit and automatic connection attempts,
main-process binding retirement, SSH retry cancellation, modal focus containment, and every session
configuration surface that presents asynchronous readiness copy. It distinguished initial
presentation from later revalidation and verified that 150 ms remains a presentation boundary, not
a synchronous IPC or filesystem timeout.

```review-scope
src/main/remote-host/service-lifecycle-races.test.ts
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/RemoteHost/RemoteConnectionCards.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.test.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.test.tsx
src/renderer/components/SessionDetail/RemoteHandOffDialog.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.a11y.test.tsx
src/renderer/components/__tests__/HandOffPreviewDialog.test.tsx
src/renderer/components/__tests__/NewSessionDialog.readiness.test.tsx
src/renderer/components/new-session/NewSessionForm.tsx
src/renderer/remote-host/remote-dialogs-test-fixture.ts
src/renderer/remote-host/use-remote-host-snapshot.test.tsx
src/renderer/remote-host/use-remote-host-snapshot.ts
src/renderer/remote-host/use-remote-session-source-test-fixture.ts
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Renderer serialization placed Disconnect behind the same pending Connect promise, so a hung connection or infinite retry could prevent the stop request from reaching the main process. | Give explicit Disconnect an independent per-profile stop mutation. Main-process retirement immediately closes the transport/retry lifecycle and rejects the superseded Connect attempt. |
| MEDIUM | One global `busy` flag disabled close, Escape, Disconnect, edit, and delete even when those actions did not conflict with the active mutation. | Project mutation activity by operation and profile. Close and Escape remain available; only genuinely conflicting controls are disabled. |
| MEDIUM | Local handoff skipped the shared initial 150 ms grace, while later Remote handoff refreshes had no delayed progress presentation. | Apply the shared initial readiness state to Local handoff and the shared delayed fallback to Remote revalidation without collapsing settled content. |
| LOW | Fast adapter discovery with no available assistants briefly rendered “正在读取助手配置…” after the read had already settled. | Render the final empty state directly and reserve progress copy for the shared delayed fallback. |

## Validation and evidence

- Renderer tests prove that Disconnect is dispatched before a pending Connect settles, mutation
  activity is scoped per operation/profile, the cancelled Connect cannot surface a stale error, and
  explicit Disconnect also cancels startup auto-connect.
- Main-process lifecycle coverage proves that Disconnect closes a pending transport immediately,
  leaves the snapshot offline, and prevents a late hello from reviving the retired binding.
- Modal coverage proves that reconnecting does not block close, Escape, edit, delete, or Disconnect,
  while profile-registry mutations disable only the related profile controls.
- Timing coverage proves that progress copy is absent at 149 ms, appears at 150 ms, and disappears
  when the configuration settles; fast empty adapter discovery reveals its final state directly.
- Focused validation passed 7 files / 57 tests.
- `pnpm typecheck`: passed, including renderer architecture and Core Node boundary checks.
- `pnpm test`: 966 files passed, 2 skipped; 6,119 tests passed, 3 skipped.
- `pnpm build`: passed.
- `git diff --check` and the changed production 500-line gate passed.

## Residual risk

- The 150 ms threshold remains a renderer presentation policy. A blocked renderer cannot paint at
  the exact boundary, but the underlying IPC stays asynchronous.
- Disconnect retires the current desktop-to-Remote transport and its reconnect lifecycle; it does
  not stop or uninstall the Relay or Worker service on the remote machine.

## Verdict

PASS. No open CRITICAL, HIGH, MEDIUM, or LOW finding remains in the reviewed connection and session
readiness scope.

## Follow-ups

None required for this scope.
