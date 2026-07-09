---
plan_id: claude-compaction-thinking-copy-20260618
status: completed
created_at: 2026-06-18
base_branch: main
base_commit: 6c06fa7
worktree_path: /Users/wanglidong/Repository/agent-deck
related_changelog: CHANGELOG_291
related_review: REVIEW_125
---

# Claude Compaction Event Display And Thinking Copy

## Goal And Invariants

Claude-side context compaction must produce a visible timeline event for both in-app SDK sessions and hook-observed CLI sessions. Existing Codex `contextCompaction` rendering remains unchanged. Claude-family ActivityFeed thinking content must read `THINKING`, while Codex thinking content keeps `REASONING SUMMARY` because Codex emits display-safe reasoning summaries.

Do not touch the existing dirty Codex adapter files. Keep the change scoped to Claude translation, hook wiring, renderer copy, tests, and required project records.

## Evidence

- Local SDK package `@anthropic-ai/claude-agent-sdk@0.3.178` defines `SDKCompactBoundaryMessage` as `type: 'system'`, `subtype: 'compact_boundary'`, with `compact_metadata.trigger/pre_tokens/post_tokens/duration_ms`.
- The same SDK types expose `PostCompactHookInput` with `trigger` and `compact_summary`; prior HookInstaller did not install `PostCompact`, and HookRoutes had no `/hook/postcompact` route.
- Codex app-server translation already renders `contextCompaction` as a visible assistant message.
- Renderer `ThinkingBubble` and TeamDetail event badges had one hardcoded label; they now branch so Claude-family sessions show `THINKING` and Codex sessions keep `REASONING SUMMARY`.

## Checklist

- [x] Add Claude SDK `compact_boundary` translation to a visible message.
- [x] Add Claude Hook `PostCompact` install, route, and translator.
- [x] Change renderer thinking row copy to adapter-aware `THINKING` / `REASONING SUMMARY` and update related empty-state text.
- [x] Add focused regression tests for SDK translation and hook translation/route installation.
- [x] Add changelog/review records and run focused tests plus `pnpm typecheck`.

## Validation

- `pnpm test:node src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-compact-boundary.test.ts src/main/adapters/claude-code/__tests__/post-compact-hook.test.ts src/renderer/components/activity-feed/rows/thinking-row.test.tsx src/renderer/components/TeamDetail/__tests__/events-payload-describe.test.ts` passed: 4 files / 38 tests.
- `pnpm typecheck` passed.

## Next-Session First Action

No follow-up is required for this plan. If future work touches thinking copy again, preserve the adapter split: Claude-family `THINKING`, Codex `REASONING SUMMARY`.
