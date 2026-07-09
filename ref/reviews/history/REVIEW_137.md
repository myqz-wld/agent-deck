# REVIEW_137

## Trigger Context

The user reported that Claude-side ExitPlanMode approval still looked like it lost jsonl history. The supplied log showed:

- old SDK-derived `session-end` first,
- old query loop ending with `[ede_diagnostic] ... stop_reason=tool_use`,
- then `claude-jsonl-fallback precheck MISS -> fresh-cli fallback` for `sessionId != cliSessionId`.

This differs from REVIEW_134. The stream-drain ordering was no longer the failing edge; the remaining problem was a false jsonl miss on the persisted `cliSessionId` dimension.

## Finding

### MEDIUM: Restart self-heal could reject valid applicationSid jsonl because lastEventAt was too broad

Status: fixed.

`maybeJsonlFallback()` already handled phantom runtime ids by probing `applicationSid.jsonl` when `cliSessionId.jsonl` was missing. It only accepted that jsonl when its mtime was not older than `SessionRecord.lastEventAt - 2s`.

For restart flows, `lastEventAt` is a broad application activity timestamp. It may be advanced by waiting/cancellation/lifecycle events around ExitPlanMode and restart, while the transcript jsonl is only expected to track real conversation content. That can make `applicationSid.jsonl` look stale even when it is the correct transcript to resume.

Fix:

- Keep the stricter `lastEventAt` gate for recover paths.
- In restart paths, if `applicationSid.jsonl` exists but fails `lastEventAt`, compare it against the latest real conversation message timestamp from `listMessagesFn(sessionId, 1)`.
- Resume `applicationSid` when that message-level freshness passes.
- Keep fallback behavior when the jsonl is older than the latest message, the mtime probe fails, or no applicationSid jsonl exists.

## Validation

- Added helper tests for restart message-freshness self-heal and true stale rejection.
- Focused restart/jsonl/ExitPlanMode tests passed: 49 tests.
- `pnpm typecheck` passed.

## Related Changelog

CHANGELOG_317.
