---
plan_id: PLAN_4
created_at: 2026-07-11
completed_at: 2026-07-11
status: completed
related_changelog: CHANGELOG_359
related_review: REVIEW_149
---

# PLAN_4_session-pinning-reviewer-model: Persistent Live pins and Codex reviewer runtime

## Goal

Update the bundled Codex reviewer fallback to `gpt-5.6-sol` / `xhigh` without changing review skill
semantics, and add persistent Live-session pinning that protects pinned sessions from automatic
lifecycle decay and retention cleanup.

## Context and Decisions

- Implementation started from clean baseline `93d7048f1f324c9ea5f89db75b40a21d40581d20`, whose tree
  exactly captured the previously reviewed Continuation Context delta and frozen dirty-main state.
- Only `resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml` was editable prompt scope.
  The four paired simple/deep skill bodies were validation-only and remained unchanged.
- Pinning dormant reactivates it. Automatic scheduler/GC work cannot transition or delete a pinned
  row. Deliberate archive, handoff, shutdown, delete, or real `session-end` remains allowed and
  clears the pin.
- The Live list preserves pinned sessions and their necessary spawn/team ownership closure even when
  the result exceeds its normal 100-row capacity.
- The user explicitly replaced the normal heterogeneous review gate with one standalone Codex
  `gpt-5.6-sol` / `xhigh` reviewer.

## Completed Work

1. Refreshed prompt inventory, created a manifest-backed backup, changed only the approved model
   line, validated paired skills, and added a bundled runtime contract test.
2. Added v039 `pinned_at`, partial indexes, legacy/fresh migration coverage, constraint checks, and
   query-plan tests.
3. Added dedicated pin persistence, stale-upsert immunity, rename preservation, all-pinned capacity,
   and recursive live ownership closure.
4. Added atomic final-write guards to lifecycle decay and retention deletion, plus deliberate
   terminal clear behavior.
5. Added strict IPC/preload integration, committed-record event emission, card/detail controls,
   deterministic Live ordering, and zh-CN labels.
6. Updated README and repository records, ran focused/full validation, and resolved the reviewer's
   one MEDIUM capacity/lineage finding.

## Validation

- Full suite: 250 files / 2,413 tests passed.
- Final focused post-fix gate: 4 files / 35 tests passed.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, diff checks, migration checks, prompt-asset
  validators, file-size checks, and review-expiry inventory passed.
- Final single-reviewer result: APPROVE; 0 CRITICAL, 0 HIGH, 1 MEDIUM fixed, no remaining material
  finding.

## Final Status and Handoff

At delivery, dirty main's HEAD and complete snapshot tree were reverified against the frozen
manifest before applying only the post-`93d7048` implementation delta. No reset, reconciliation, or
application restart was performed. After the user requested commit/push/cleanup, the reviewed
commit chain was fast-forwarded to main and `origin/main`, then both redundant implementation
worktrees and branches were removed after remote equality verification. The running app must be
restarted later, at a safe point, before the new schema, preload API, and UI controls become active.

Related records: [CHANGELOG_359](../../changelogs/recent-3-days/CHANGELOG_359_session-pinning-reviewer-model.md)
and [REVIEW_149](../../reviews/recent-3-days/REVIEW_149_session-pinning-reviewer-model.md).

Completed At: 2026-07-11
