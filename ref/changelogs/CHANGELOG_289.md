# CHANGELOG_289 - SDK sandbox/permission restart resume

## Summary

- Codex sandbox cold restart now uses an app-server `thread/resume` rebind when the jsonl thread exists. It does not send `SDK_RESTART_RESUME_PROMPT`, does not start `turn/start`, and does not write a visible "switching sandbox" timeline message on the normal success path.
- Codex jsonl-missing fallback is unchanged: it still creates a fresh CLI thread with an actual prompt so DB-backed history can be injected.
- Claude `setPermissionMode` now treats "DB session exists but no live SDK query" as a successful persisted change. This fixes the detail-page permission switch reporting "session not found" before the Claude SDK session has been recovered/restarted.

## Validation

- `pnpm test:node src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts`
- `pnpm test:node src/main/adapters/claude-code/sdk-bridge/__tests__/set-permission-mode-rollback.test.ts`
