# CHANGELOG_291 - Claude compaction events and adapter-aware thinking copy

## Summary

- Claude SDK `system.compact_boundary` frames now render as visible timeline messages with trigger, token delta, and duration metadata.
- Claude Hook support now installs and routes `PostCompact`, rendering the hook `compact_summary` as a visible context-compaction message for hook-observed CLI sessions.
- ActivityFeed thinking copy is adapter-aware: Claude-family sessions display `THINKING`, while Codex sessions keep `REASONING SUMMARY`.
- TeamDetail's event badge and empty-payload fallback copy follow the same adapter split for thinking events.

## Validation

- `pnpm test:node src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-compact-boundary.test.ts src/main/adapters/claude-code/__tests__/post-compact-hook.test.ts src/renderer/components/activity-feed/rows/thinking-row.test.tsx src/renderer/components/TeamDetail/__tests__/events-payload-describe.test.ts`
- `pnpm typecheck`

## Do Not Split Protection

- `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts` remains over 500 LOC. This change kept new formatting logic in `src/main/adapters/claude-code/compact-message.ts`; the remaining edit is a narrow branch in the central SDK message dispatcher and splitting the dispatcher itself is outside this focused bug fix.
