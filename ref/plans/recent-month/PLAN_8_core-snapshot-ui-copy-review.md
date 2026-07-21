---
plan_id: PLAN_8
title: Solo core snapshot and UI copy review
status: completed
created_at: 2026-07-11
updated_at: 2026-07-12
completed_at: 2026-07-12
base_branch: main
base_commit: be6781ec623a3edf7b6fa50dd1aa8847cc7efe29
related_review: REVIEW_154
---

# PLAN_8_core-snapshot-ui-copy-review: Solo core audit and copy cleanup

## Goal and invariants

Independently review core Agent Deck behavior for evidenced defects, simplify user-facing UI/CLI
copy in natural Simplified Chinese, fix confirmed issues with regression coverage, and inspect paired
prompt assets without changing them unless a real semantic defect is found.

The review had to remain solo: no `simple-review`, `deep-review`, reviewer agent, or discovery agent.
Existing working-tree content outside this audit was to be preserved, and review-driven fixes belong
in a final review record rather than a feature changelog.

## Confirmed scope and decisions

- Prioritize renderer/main synchronization around sessions, events, summaries, pending requests,
  CLI focus, history navigation, and user-visible failure handling.
- Audit renderer settings, dialogs, empty states, errors, accessibility labels, and bundled CLI
  wrappers against `UI_COPY_LANGUAGE.md`.
- Treat the work as a risk-based core audit rather than exhaustive review of every repository file.
- Compare current Claude/Codex prompt assets and their fresh inventory; edit only on evidenced drift.
- Preserve technical identifiers such as MCP, provider, adapter, session, token, and tool names.

## Completed checklist

- [x] Read repository, Codex runtime, review-expiry, and UI-copy conventions.
- [x] Confirm baseline `be6781ec623a3edf7b6fa50dd1aa8847cc7efe29` and a clean initial tree.
- [x] Run baseline typecheck and full test suite.
- [x] Reproduce and fix pending, session, event, summary, focus, and history races.
- [x] Contain routine renderer IPC failures with local errors or bounded logging.
- [x] Simplify renderer and CLI copy and correct the 19-tool MCP inventory.
- [x] Compare paired prompt assets; retain them unchanged because semantics and hashes were current.
- [x] Add focused regression coverage and synchronize copy-sensitive tests.
- [x] Pass typecheck, full tests, production build, logger guard, shell syntax, diff, and LOC gates.
- [x] Attempt the required development restart and document the installed-app single-instance limit.
- [x] Archive the final review and plan records and remove temporary working copies.

## Validation and residual risk

- Final repository gate: 271 test files and 2,542 tests passed; one opt-in live smoke remained skipped.
- Main, preload, and renderer production builds passed. Development compilation also passed through
  Electron launch before the running installed app correctly retained the single-instance lock.
- The stable-snapshot helper favors live correctness over unsafe late replacement after four failed
  stabilization attempts. Sustained event streams may delay older-history hydration, not remove new
  live state.
- Windows-specific wrapper execution remains untested locally because no Windows runtime or `pwsh`
  was available.

## Completion

Implementation, solo review, copy cleanup, prompt comparison, validation, and durable records are
complete. The installed application should receive the main/preload changes on the user's next safe
restart; the active instance was not terminated because it was carrying this session.
