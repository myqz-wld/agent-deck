---
plan_id: PLAN_25
title: Hook event lifecycle completeness
status: completed
created_at: 2026-07-30
updated_at: 2026-07-30
completed_at: 2026-07-30
base_branch: main
base_commit: e04d743d8c352eec73252e24219cb87734f7270c
related_changelog: CHANGELOG_415
---

# PLAN_25_hook-event-lifecycle-completeness: Complete normalized hook capture

## Goal

Preserve meaningful provider hook lifecycle information across Claude Code, Codex CLI, and Grok
Build while keeping SDK-owned session deduplication and canonical assistant-message semantics
unchanged.

## Invariants

- Do not add provider-version detection; unsupported hooks behave as absent events.
- Do not change event-list pagination.
- Do not persist raw transcripts or raw hook envelopes.
- Keep SDK/app-server events authoritative for SDK-owned sessions.
- Do not reinterpret Claude display fragments as canonical assistant messages.
- Do not invent a Codex tool failure result when the provider omits `PostToolUse`.

## Completed steps

- [x] Inventory provider hook contracts, translators, routes, activity state, persistence, and
      renderer fallbacks.
- [x] Add normalized compaction, subagent, and display lifecycle event kinds.
- [x] Install and route `PreCompact`, `SubagentStart`, and `SubagentStop` across all adapters, plus
      Claude `MessageDisplay`.
- [x] Convert compaction signals from synthetic assistant messages to first-class lifecycle events.
- [x] Mark Codex `PostToolUse` as completed and reconcile unmatched starts at `Stop`/`SessionEnd`.
- [x] Clear terminal permission waiting state and render synthesized `aborted` outcomes explicitly.
- [x] Exclude display-only deltas from continuation, checkpoint-backlog thresholds, and
      periodic-summary evidence.
- [x] Add adapter contract, translation, SQLite, state-machine, renderer, and summary regressions.
- [x] Run focused tests, typecheck, the Electron full suite, production build, diff checks, and
      review-expiry analysis.

## Validation result

- Focused hook/state/store run: 94 tests passed; the one plain-Node SQLite skip passed in the
  Electron-ABI full suite.
- Full suite: 473 files passed plus one intentional skip; 4,036 tests passed plus one skip.
- Typecheck, production build, logger validation, and diff whitespace validation passed.
- Every changed production source remains at or below 500 lines.

## Final status

Completed on 2026-07-30. The three external-hook adapters now preserve the shared lifecycle events
available from their providers, and Codex terminal sessions no longer leave successful or
unclosed tool activity in an ambiguous state.
