# REVIEW_134

## Trigger Context

User reported that on the Claude side, choosing ExitPlanMode approval with bypass / no-ask mode and then restarting the SDK could lose the jsonl file without a clear UI prompt. The supplied runtime log showed `claude-jsonl-fallback` reporting `precheck MISS` before the old Claude stream logged `session-end` and `[ede_diagnostic] ... stop_reason=tool_use`.

## Method

Targeted incident review over the Claude SDK restart path:

- ExitPlanMode approve-bypass handling.
- `restartWithPermissionMode` close -> jsonl precheck -> create-session sequencing.
- `closeSession` interrupt and cleanup semantics.
- `stream-processor` `finally` cleanup and `session-end` emission.
- Existing jsonl-missing fallback behavior and regression tests.

This was a focused local review and fix, not a multi-agent adversarial review.

## Findings

### MEDIUM: Restart jsonl precheck could race ahead of old SDK stream cleanup

Status: fixed.

`restartWithPermissionMode` awaited `closeSession()` and then immediately called `maybeJsonlFallback()`. However, `closeSession()` only awaited `query.interrupt()` and then ran close cleanup; it did not wait for the SDK stream consumer to enter `finally`.

In the reported log, the jsonl precheck happened about 180 ms before the old stream emitted its close tail:

- `19:25:09.673`: `precheck MISS -> fresh-cli fallback`
- `19:25:09.849`: old SDK-derived `session-end`
- `19:25:09.859`: old query loop ended with `[ede_diagnostic]`

That ordering can make a valid resume jsonl look missing during the close window, sending the restart down fresh fallback and producing the user's apparent history-loss symptom.

Fix:

- `InternalSession` now carries a `streamDrained` promise.
- `stream-processor` resolves it after existing `finally` cleanup.
- `closeSession()` waits for it, bounded at 1 second, after interrupt/cleanup.
- Restart paths already await `closeSession()`, so their jsonl precheck now runs after the old stream has drained when the SDK behaves normally.

### LOW: Handwritten test fixtures drifted from `InternalSession`

Status: fixed.

Two tests constructed `InternalSession` manually and missed the new drain fields. One fixture now uses `makeInternalSession`; the fork-consume test adds the minimal drain fields it needs while preserving the old private-consume test shape.

## Validation

- Targeted Vitest set passed: 5 files, 59 tests.
- `pnpm typecheck` passed.

## Related Changelog

CHANGELOG_314.
