---
changelog_id: 354
changed_at: 2026-07-10
---

# CHANGELOG_354_thinking-options-and-claude-usage: Refine thinking options and Claude usage

## Summary

The Codex reasoning selector used by periodic summaries and Hand-off briefs no longer shows the model-specific `max` choice, while Claude and Deepseek keep their valid `max` option. Claude-family sessions now populate reasoning-token statistics from the SDK's approximate thinking-token stream when the CLI does not provide an authoritative output breakdown.

## Changes

### Summary and Hand-off settings

- Removed `MAX` from the Codex settings dropdown without narrowing MCP, custom-agent, app-server, or provider passthrough capabilities.
- Kept `MAX` available for Claude and Deepseek.
- Coerced a Claude-family `max` value to `xhigh` when the user switches that row to Codex.
- Migrated retained Codex summary / Hand-off `max` settings to `xhigh`; `ultra` is not used as an alias because it also enables automatic task delegation.
- Preserved model-specific backend support: Codex 0.144.0 currently reports `max` for GPT-5.6 sol / terra / luna, while GPT-5.5 and GPT-5.4 stop at `xhigh`.

### Claude reasoning usage

- Consumed the Claude Agent SDK `system/thinking_tokens` frames that the previous translator ignored.
- Accumulated only finite positive `estimated_tokens_delta` values per turn and actual stream-model bucket; cumulative totals are never summed.
- Deferred persistence until the result frame to avoid one synchronous SQLite write and renderer notification per stream delta.
- Preferred an authoritative result breakdown when available, otherwise flushed the SDK estimate after subtracting reasoning already persisted from assistant messages.
- Clamped reasoning to inclusive output totals, prevented duplicate replay by SDK UUID, distributed multi-model aggregate reasoning once, and cleared partial estimates on expected close or resultless stream termination.
- Preserved Deepseek model rewriting for reasoning-only correction rows because it shares the Claude bridge.

## Validation

- Focused validation: 6 files and 47 tests passed.
- `pnpm typecheck`
- `pnpm test` — 204 files and 2227 tests passed.
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`

## Do Not Split Protection

`src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts` was already 669 lines at the baseline and is 694 lines after adding only the system-frame capture and result-flush integration. The new accounting, clamping, allocation, and cleanup logic is isolated in the 320-line `thinking-token-usage.ts`; splitting the remaining translator during this focused fix would mix unrelated message/tool/file-change behavior into the risk surface. Revisit the translator split when the next independent translation feature is added or the file reaches 720 lines.

## Notes

- Claude's current SDK thinking-token signal is explicitly approximate, not an authoritative billed reasoning breakdown.
- Bundled runtime prompts and the MCP tool description remain unchanged because they describe model-specific backend capabilities, which still include `max` for some Codex models.
- The hosting installed Agent Deck application was not restarted because it owns this implementation session; restart it before interactive verification.
- Related review: [REVIEW_145](../../reviews/recent-month/REVIEW_145_claude-reasoning-usage.md).
