---
plan_id: 49
completed_at: 2026-09-04
status: completed
baseline_commit: 365dabc0eab9f328ac9fc0cbd6938ecef4ca5a7d
---

# Multiple Codex quota groups, reviewer defaults and model inventory

## Goal and authorized boundaries

Repair Astra Data panel support, set the Codex/Grok reviewer defaults to the exact requested models, preserve reasoning effort, and report current model-name locations in Agent Deck and the sibling Skill Market checkout. Model example lists and Skill Market content remain unchanged for the user's subsequent decisions.

## Decisions and implementation

- Source inspection found a reproducible multi-quota loss: only one Codex account quota group was retained. Implemented complete quota projection with stable optional quota identity, scoped Remote validation and shared renderer keys. Existing Astra token normalization already worked and now has explicit regression coverage. A symptom clarification was requested but no reply or live provider payload was used.
- Updated only the reviewer model metadata to gpt-6-astra/xhigh and grok-4.6/high. Backed up and validated the two assets through prompt-asset-improver; explicit user model/effort instructions supplied the existing authorization.
- Inventoried agent-visible spawn/handoff model suggestions, their test-only example array usage, free-text runtime validation, generic Grok defaults and the shim model catalog. No unrelated model or thinking setting changed.
- Inspected all 45 canonical Skill files and related supporting templates/catalog metadata in the sibling Skill Market checkout. The three parallel-tasks copies share one current reference table; other model mentions are generic boundaries or placeholders.

## Quota clarification

Completion below covers the implemented generic quota projection, reviewer defaults, and inventory. It does not establish that Astra has an independent quota pool or that the user's unspecified Data panel symptom was repaired. See the official-source correction in REVIEW_270. Later model-routing decisions are handled by PLAN_50 / CHANGELOG_640.

## Validation and completion

- Focused 10 files / 96 tests passed; complete suite 1,024 files / 6,346 tests passed with three existing platform/opt-in skips.
- Typecheck, architecture boundaries and production build passed. Twelve changed source/test/assets remain below 500 lines; SQLite binding unchanged.
- No source changes in Skill Market, no user database/provider-transcript access, live provider calls, host process actions, dependency installation, commit/push or deployment.
- Final implementation and inventory: [REVIEW_270](../../reviews/recent-3-days/REVIEW_270_astra-usage-and-model-inventory.md), [model-name inventory](../../reviews/recent-3-days/astra-usage-model-inventory/model-name-inventory.md).
- Remaining product decisions: desired spawn model suggestions, generic Grok defaults and shim catalog, and each Skill Market tier reference. Await the user's concrete modification instructions for these inspection-only areas.
