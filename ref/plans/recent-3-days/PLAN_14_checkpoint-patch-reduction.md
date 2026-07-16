---
plan_id: PLAN_14
title: Deterministic checkpoint patch reduction
status: completed
created_at: 2026-07-15
updated_at: 2026-07-15
completed_at: 2026-07-15
base_branch: main
base_commit: 4b58d6782ba11787b05e3423d545bc38b7955b6f
related_review: REVIEW_163
---

# PLAN_14_checkpoint-patch-reduction: Make the application own checkpoint state

## Goal and invariants

- Ask the LLM only to infer semantic changes from the current normalized delta.
- Preserve all omitted checkpoint facts in deterministic application code instead of asking the
  model to reproduce them byte-for-byte.
- Keep the persisted `ContinuationCheckpoint` format, database history, deadline, call limits, and
  backoff policy unchanged.
- Require every mutation to cite exact current-delta evidence and keep app-owned coverage markers
  outside the model contract.

## Confirmed decisions

- Use a transient `CheckpointPatch` with additions and field-level updates; no delete operation.
- Represent unchanged update fields as `null`; an empty patch is a valid no-change result.
- Merge patch evidence with prior evidence deterministically and retain the existing canonical-fit,
  CAS, active-fact, and coverage-marker defenses.
- Publish the complete actionable validator contract in the first-attempt system prompt.
- Send repair every structured validation issue with `code`, `path`, `message`, and
  `requiredAction`, but omit the full normalized delta and full prior checkpoint from repair input.
- Keep bundled Claude/Codex instructions, UI, persistence schema, and runtime budgets out of scope.

## Completed checklist

- [x] Confirm the architecture and exact prompt-asset scope through the Agent Deck plan gate.
- [x] Inventory and hash-back up `checkpoint-prompts.ts` before editing it.
- [x] Add the transient patch schema, provider JSON schema, semantic validator, and reducer.
- [x] Switch Claude, Deepseek, and Codex structured output plus fold/repair handling to patches.
- [x] Aggregate validation issues and keep safe diagnostic categories for scheduler logging.
- [x] Cover empty patches, field-level updates, exact evidence, multiple simultaneous errors,
      bounded repair input, overflow fitting, CAS conflicts, and adapter schema passthrough.
- [x] Pass typecheck, the full Electron-ABI test suite, production build, logger check, and diff check.
- [x] Run the production checkpoint path against a real Codex app-server provider with an isolated
      in-memory database and verify one-call, zero-repair patch reduction and CAS persistence.

## Validation and completion

The application now owns canonical state and advances unchanged revisions with an empty patch. The
LLM returns only evidence-backed additions or changed fields; repair input no longer replays the
large source delta. All 318 automated test files passed with 2,886 tests. The opt-in Codex live
smoke was then run separately against a real app-server provider and passed in 15.9 seconds with one
provider call, zero repairs, a non-empty patch, exact preservation of an omitted prior goal, and a
revision-1-to-2 CAS commit. The currently running Agent Deck host was intentionally not restarted
because it owns the active implementation session.
