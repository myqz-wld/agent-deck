---
changelog_id: 613
changed_at: 2026-08-15
---

# CHANGELOG_613_interruptible-reconnect-and-session-readiness: Keep reconnects escapable

## Summary

Remote connection attempts can now be interrupted immediately, and every new-session or handoff
configuration surface follows the same 150 ms loading-presentation rule.

## Changes

### Interruptible Remote connections

- Keep the Remote data-source window closable with its close control or Escape while a connection
  or automatic reconnect is running.
- Keep Disconnect available during connecting and reconnecting; clicking it immediately sends an
  independent stop request instead of waiting behind the pending Connect operation.
- Cancel the active SSH attempt, retry timer, and startup auto-connect lifecycle through the
  existing main-process connection retirement path, while suppressing the stale failure from the
  cancelled attempt.
- Scope disabled controls to the mutation they conflict with: profile edits block only profile
  registry changes, source selection blocks only source selection, and an explicit Disconnect
  blocks only another Disconnect for the same profile.

### Complete 150 ms session readiness

- Delay Local handoff configuration presentation by the shared 150 ms grace period, while mounting
  the modal backdrop immediately so the page underneath remains inert.
- Keep a settled Remote handoff form mounted during later configuration refreshes and show
  “正在更新会话配置…” only when the refresh crosses the grace boundary.
- Reveal the final “没有可用的助手” state directly when adapter discovery finishes quickly instead
  of briefly claiming that configuration is still loading.
- Preserve the existing rule for Local and Remote new-session and issue-resolution paths: a fast
  asynchronous read reveals complete content directly; only a slower read displays progress copy.

## Validation

- Seven focused regression files passed 57 tests across the connection lifecycle, Remote manager,
  new-session, Local/Remote handoff, and modal accessibility paths.
- The complete Electron suite passed 966 files and 6,119 tests; 2 files and 3 opt-in cases were
  skipped.
- `pnpm typecheck` passed, including renderer architecture and Core Node boundary checks.
- `pnpm build` passed.
- `git diff --check` and the production 500-line limit passed.

## Do Not Split Protection

No exception is required. Every changed production TypeScript file remains below 500 lines; the
largest is the 488-line Local handoff dialog.

## Related review

- `ref/reviews/recent-3-days/REVIEW_250_interruptible-reconnect-and-session-readiness.md`
