# REVIEW_125 - Claude compaction display and thinking copy

## Trigger Context

User reported that Claude-side context compaction events were not displayed, and clarified that Claude-family thinking rows should say `THINKING` while Codex should keep `REASONING SUMMARY`.

## Method

- Inspected local `@anthropic-ai/claude-agent-sdk@0.3.178` types for the actual compaction event shapes.
- Compared existing Codex app-server `contextCompaction` handling.
- Checked Claude Hook installer/routes/translation and renderer ActivityFeed/TeamDetail copy.
- Added focused regression coverage for SDK compaction, Hook `PostCompact`, and adapter-aware thinking labels.

## Findings And Fixes

### LOW-1 fixed: Claude SDK compact boundary was ignored

Evidence: `SDKCompactBoundaryMessage` is a `system` frame with `subtype: 'compact_boundary'`, but `translateSdkMessage` only handled assistant/user/result/status/stream_event paths.

Fix: `translateSdkMessage` now renders `compact_boundary` as an assistant timeline message using shared compact-message formatting.

### LOW-2 fixed: Claude Hook did not observe PostCompact

Evidence: Claude SDK types list `PostCompactHookInput`, but `HOOK_EVENTS` omitted `PostCompact` and `buildHookRoutes` had no `/hook/postcompact` route.

Fix: Hook installation includes `PostCompact`, routes accept `/hook/postcompact`, and `translatePostCompact` renders the summary.

### LOW-3 fixed: Thinking label needed adapter split

Evidence: `ThinkingBubble` had a single hardcoded label. Claude-family sessions needed `THINKING`, but Codex `thinking` events represent reasoning summaries and should keep `REASONING SUMMARY`.

Fix: `ThinkingBubble`, TeamDetail event badges, and TeamDetail fallback copy branch on `agentId === 'codex-cli'`.

## Validation

- `pnpm test:node src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-compact-boundary.test.ts src/main/adapters/claude-code/__tests__/post-compact-hook.test.ts src/renderer/components/activity-feed/rows/thinking-row.test.tsx src/renderer/components/TeamDetail/__tests__/events-payload-describe.test.ts` passed: 4 files / 38 tests.
- `pnpm typecheck` passed.

## Related Changelog

- CHANGELOG_291
