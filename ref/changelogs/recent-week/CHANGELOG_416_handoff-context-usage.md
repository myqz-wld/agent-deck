---
changelog_id: 416
changed_at: 2026-07-30
---

# CHANGELOG_416_handoff-context-usage: Repair hand-off and show live context

## Summary

Session hand-off no longer manufactures adapter-incompatible target fields at the IPC boundary.
Session details now show the current provider-reported context occupancy and window size, including
an explicit post-compaction updating state instead of a stale pre-compaction count.

## Changes

### Adapter-safe session hand-off

- Preserve the distinction between an omitted target runtime field and an explicitly supplied
  `null` value when parsing UI hand-off requests.
- Stop adding `sessionMode: null` to Codex CLI and Claude Code targets, fixing the strict runtime
  ownership rejection shown as `sessionMode 与 Codex CLI 不兼容`.
- Omit the unsupported `provider` field when the UI targets Grok Build while retaining explicit
  provider selection and clearing for Claude Code and Codex CLI.
- Extract the hand-off input parser into a focused IPC boundary module and cover omitted versus
  explicit-null behavior directly.

### Current-context telemetry

- Add a non-timeline `context-usage` event and a v058 per-session snapshot that stores current used
  tokens, context-window tokens, and observation time separately from the cumulative token ledger.
- Read Codex app-server `tokenUsage.last.totalTokens` and `modelContextWindow`.
- Read Claude assistant input/cache/output usage for current occupancy and select the primary
  model's `contextWindow` from finalized model usage.
- Read Grok ACP `usage_update.used` and `usage_update.size` directly.
- Preserve partial provider updates, ignore stale timestamps, survive application restart, and
  retain the snapshot across both session rename paths.

### Compaction and session UI

- Invalidate the old used-token count when first-class compaction starts while preserving the
  known window size.
- Use Claude compact-boundary `post_tokens` immediately when available; otherwise store an
  explicit unknown count until the next provider snapshot arrives.
- Show `上下文 已用 / 窗口 · 百分比` in the session detail header, with exact values in the
  tooltip, warning colors near capacity, `更新中` after compaction, and `暂无数据` for providers or
  historical sessions that have not reported a snapshot.
- Keep context occupancy out of activity history, periodic summaries, and cumulative Data totals.

### Regression coverage

- Cover hand-off field ownership, all three provider translators, compaction invalidation,
  persistent partial/stale snapshot updates, session rename continuity, and the session header
  display states.

## Validation

- `pnpm typecheck`
- `pnpm test` (478 files passed, 1 skipped; 4,057 tests passed, 1 skipped)
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`

## Do Not Split Protection

All changed production files remain at or below 500 lines. The largest touched files are the
Claude SDK message translator (493), session rename transaction (492), context-aware ingest
pipeline (455), and session detail component (407). New parser, telemetry, persistence, and
renderer responsibilities live in focused sibling modules rather than extending those facades.

## Notes

- Context usage is provider telemetry, not an estimate derived from transcript text.
- External CLI sessions show `暂无数据` until their supported native channel reports a current
  context snapshot; lifecycle-only hooks do not fabricate one.
