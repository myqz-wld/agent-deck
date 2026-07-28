---
plan_id: PLAN_10
title: Blocking present_plan and isolated deep review
status: completed
created_at: 2026-07-14
updated_at: 2026-07-14
completed_at: 2026-07-14
base_branch: main
base_commit: b64566618c64018c3343a6ae4f459ca2bf41f6bd
related_changelog: CHANGELOG_364
related_review: REVIEW_159
---

# PLAN_10_present-plan-deep-review: Durable plan gates and contextual review

## Goal and invariants

- Make omitted `present_plan.timeoutMs` wait indefinitely instead of inheriting the generic
  permission timeout.
- Retain an explicitly timed-out plan as a pending human gate; the calling flow must stop, and a
  later decision must resume the current logical owner—the original presenter before handoff, or
  the latest committed successor afterward—as a new user turn.
- Add a large plan-review dialog with selectable plan text, quote insertion, a dedicated question
  composer, and approve / continue-modifying / context-feedback actions.
- Use exactly one same-adapter, same-cwd provider-native fork per pending plan. Preserve the source
  permission, sandbox, model, Thinking, and Codex access settings; never fall back to a fresh child.
- Keep native Claude ExitPlanMode and `present_diff` behavior unchanged, preserve unrelated working
  tree changes, and keep first-party source files below 500 lines.

## Confirmed decisions

- The user approved the complete implementation plan through the existing `present_plan` gate.
- An explicit timeout releases only the MCP tool call. Agent Deck retains the pending card until the
  user responds or the owning session is deliberately closed.
- The internal fork retains normal spawn lineage but suppresses the reply anchor and lead-context
  injection, preventing review output from steering the blocked parent.
- The child receives the plan explicitly and is instructed to work read-mostly, avoid file and
  external-state changes, and avoid cross-session messages. This is prompt discipline rather than a
  permission downgrade.
- Automatic context feedback is terminal: the child generates focused revision feedback, and the
  application submits it through the same continue-modifying decision path.

## Completed checklist

- [x] Inventory and back up the confirmed long-lived prompt assets before editing.
- [x] Refactor plan review into an injectable active / timed-out state machine with retryable late
      delivery, idempotent child creation, automatic feedback, and child cleanup.
- [x] Add a plan-review session coordinator and focused runtime prompt builders.
- [x] Add trusted internal spawn options for silent lineage and Codex access inheritance without
      changing the public MCP schema or ordinary spawn behavior.
- [x] Add dedicated shared IPC channels, main registration, preload facade, and renderer callers.
- [x] Add the expanded dialog, selectable quote capture, child conversation, question composer, and
      three plan actions while retaining compact-card behavior.
- [x] Align MCP descriptions, README, and paired Claude/Codex runtime protocol wording.
- [x] Add state-machine, fork-isolation, access-inheritance, timeout, automatic-feedback, and renderer
      interaction regressions.
- [x] Pass the full Electron test suite, full typecheck, production build, and diff validation.

## Validation and residual risk

- `pnpm test` passed 306 files and 2,829 tests; one opt-in live smoke remained skipped.
- `pnpm typecheck`, `pnpm build`, `git diff --check`, and all new focused tests passed.
- Provider-native fork eligibility remains authoritative. If the active provider boundary cannot be
  forked, the dialog shows the exact error and does not create a fresh substitute.
- A final `pnpm dev` launch rebuilt main, preload, and renderer successfully. The already-running
  installed Agent Deck instance retained the single-instance lock, so no second development window
  remained open; the installed host needs a safe restart/rebuild before it can load these changes.

## Completion

The blocking gate, handoff-aware late-decision resume path, isolated review conversation,
contextual feedback submission, paired protocol documentation, regression coverage, and
prompt-asset validation are complete. Development compilation was rechecked; only the safe
installed-host restart/rebuild boundary remains for loading the new main/preload code into the
running application.
