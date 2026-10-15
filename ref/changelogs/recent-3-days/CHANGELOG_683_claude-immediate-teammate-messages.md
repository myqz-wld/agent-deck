---
changelog_id: 683
changed_at: 2026-10-15
---

# Immediate Claude Teammate Messages

## Summary

Claude now accepts `send_message` teammate input during an active turn, using the same immediate
SDK input path as the session composer. Previously, teammate input waited for the current turn
to finish. The existing conversation and wire prefix are preserved.

## Changes

- Pass the existing deferred acceptance metadata and the durable message ID from
  `ClaudeCodeAdapter.receiveTeammateMessage` into the SDK bridge. This permits mid-turn delivery
  with `priority: 'now'` and correlates provider acceptance and interruption results.
- Retain message-ID deduplication, ordered submissions, worktree transition gates, and the existing
  recovery records for unacknowledged or unsent input. Emit the user event after provider acceptance.
- Verify Grok's actual adapter-to-ACP path: teammate input already reaches `_x.ai/interject` during
  an active turn. No Grok production change is needed. Unsupported runtimes and lifecycle boundaries
  retain their existing queued fallback.
- Add adapter-to-provider-boundary regression coverage for both providers. Keep README concise;
  delivery details remain in this changelog.
- Rebucket changelog 675 by its unchanged date and update its bucket indexes and referring plan
  link. The root routing policy is unchanged.

## Validation

- The six new Claude cases failed against the previous adapter wiring, then passed after the change.
  They cover idle and active delivery, exact wire content, consecutive input, retry deduplication,
  interruption classification, stream-loss recovery, and the worktree transition gate.
- Three new Grok cases passed: immediate interjection with deduplication, unsupported-extension
  fallback, and worktree-transition gating.
- Focused delivery, acceptance, recovery, interruption, and watcher tests: 130 passed.
- Final new-test rerun after fixture typing corrections: 9 passed.
- `pnpm typecheck` passed architecture checks, Core boundaries, and both TypeScript projects.
- Full `pnpm run test --maxWorkers=4 --minWorkers=1 --reporter=dot`: 1,172 files and 7,364 tests
  passed; 3 files and 6 opt-in tests skipped.
- The SQLite binding SHA-256 was unchanged after validation. No native binding rebuild was needed.
- `git diff --check`, changed documentation links, and changelog bucket/index consistency passed.

## Do Not Split Protection

None required. Changed source and test files remain below 500 lines.

## Notes

Provider boundaries were exercised with deterministic SDK/ACP test doubles; no live model request
or cross-session message was sent. Delivery acknowledgement still means adapter acceptance, not
completion of the recipient's work. Runtime acceptance, FIFO ordering, and transition guards can
briefly defer a message; immediate delivery does not bypass those boundaries.

Main-process changes require a development rebuild/restart or an updated installed application
to become active. The running application and installed bundle were not restarted or replaced.
