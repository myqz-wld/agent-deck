# REVIEW_130

## Trigger Context

User reports:

- "选择工作目录的时候总是卡一下，优化一下"
- Quota refresh should remain 5 minutes after an initial 10-minute request was withdrawn.
- "codex创建会话比较慢，这里看看有没有优化时间"

## Method

Targeted trace and self-review across:

- `NewSessionDialog` renderer browse flow and `DialogChooseDirectory` IPC.
- Provider usage preload and main-process TTL cache.
- Codex `AdapterCreateSession` → adapter → `createSessionImpl` → `runCreateSessionNewPath` → `ThreadLoop.startNewThreadAndAwaitId`.
- Existing session rename and renderer `session-renamed` handling.

No heterogeneous reviewer session was used because this was a narrow latency/UX fix with focused regression tests.

## Findings

### MEDIUM: Directory picker could stack duplicate native dialog calls

Status: fixed.

Repeated browse clicks could call `chooseDirectory` multiple times while the first native picker was still open, making the UI feel stuck and risking out-of-order cwd updates.

Fix:

- Renderer browse action now has a `pickingDirectory` single-flight guard and disabled/pending button state.
- Main IPC handler reuses an in-flight `showOpenDialog` promise.

### MEDIUM: Codex createSession waited for app-server thread id before UI could enter the session

Status: fixed.

The IPC create call waited for app-server initialize plus `thread/start` and first `thread.started`, even though the app already has temp-id rename infrastructure.

Fix:

- New Codex sessions now emit a temp session and first user message immediately.
- `startNewThreadAndAwaitId` continues in the background and uses `renameSdkSession(temp, real)` on success.
- Early error/timeout paths only append error/finished to the existing temp session.

### MEDIUM: Early Codex temp sessions introduced a close-before-real-id race

Status: fixed.

Once temp sessions are visible immediately, users can close them before `thread.started`. A late real id must not revive the closed temp session.

Fix:

- `ThreadLoop` now checks `internal.intentionallyClosed` before fallback emission and before processing late stream events.
- Regression test covers late `thread.started` after `closeSession(temp)`.

### LOW: Provider usage cadence needed an explicit 5-minute guard

Status: fixed.

The user reverted the 10-minute request, so the intended cadence is still 5 minutes. Constants are now shared and tested to avoid accidental drift.

## Validation

- Targeted Vitest set passed: 6 files, 24 tests.
- Codex create-session test file passed: 7 tests.
- `pnpm typecheck` passed.

## Related Changelog

CHANGELOG_310.
