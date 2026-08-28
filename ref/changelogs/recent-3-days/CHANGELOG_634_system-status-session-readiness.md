---
changelog_id: 634
changed_at: 2026-08-27
---

# CHANGELOG_634_system-status-session-readiness: Align status rows and Claude readiness

## Summary

Worktree and silent-command system rows now use one concise copy pattern without decorative icons
or terminal punctuation. Silent commands retain their ordinary finished-turn event, and newly
created Claude sessions no longer expose partial permission or Gateway state while starting.

## Changes

### System-status copy

- Add a host-neutral formatter for command completion and failure rows, including bounded removal
  of warning decorations and generated terminal punctuation.
- Present Claude, Codex, and Grok Build command outcomes as
  `<adapter> /<command> 已完成` or `<adapter> /<command> 失败：<reason>`.
- Align Desktop and Server Core worktree completion, cleanup-pending, recovery, and failure rows to
  the same undecorated, punctuation-free status style.
- Preserve provider-generated Claude compaction summaries verbatim below the normalized status
  header.

### Silent-command terminal parity

- Emit one visible `finished` event after every Codex `/clear` and `/compact` outcome, including
  failure and interruption.
- Stop hiding Grok Build's existing terminal event when a dynamic command completes without an
  assistant reply, and order the final system status before that terminal.
- Retain Claude's provider-native terminal event, so all three adapters now expose the same final
  timeline shape for silent commands.

### Claude session readiness

- Carry the selected permission mode, Gateway, model, thinking level, and sandbox in the trusted
  initial SDK `session-start`, writing the first visible SessionRecord atomically instead of
  broadcasting an empty runtime projection first.
- Fence the Claude runtime-control surface by exact adapter/session identity and reuse the shared
  150 ms initial-presentation policy: fast capability reads commit the final controls directly,
  while slower reads show an explicit configuration status only after the grace boundary.
- Reject equivalent runtime metadata on Hook-sourced `session-start` events so the atomic
  registration remains SDK-owned.

## Validation

- Focused regression suite: 12 files / 91 tests passed.
- `pnpm typecheck`
- `pnpm test`: 1,017 files passed and 2 skipped; 6,340 tests passed and 3 skipped.
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

No exception is required. Every changed production TypeScript file remains below 500 lines; the
largest is `src/main/session/worktree-transition/coordinator.ts` at 486 lines.

## Notes

- Main-process and Renderer code changed. The running application was not restarted or terminated
  because the user explicitly prohibited process killing; live Electron acceptance therefore
  requires a later manual restart.
- The session-private Browser had no existing page or local Renderer development server to inspect,
  so no stale-build visual claim is recorded.

## Related review

- `ref/reviews/recent-3-days/REVIEW_265_system-status-session-readiness.md`
