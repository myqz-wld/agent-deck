---
plan_id: 50
completed_at: 2026-09-04
status: completed
baseline_commit: 365dabc0eab9f328ac9fc0cbd6938ecef4ca5a7d
---

# Model routing and Grok defaults

Status: completed

## Goal and authorization

Apply the user-selected model names and defaults in Agent Deck and the sibling Skill Market packages. Preserve reasoning effort. User explicitly approved adding gpt-6-astra and grok-4.6 suggestions, defaulting Grok to 4.6, removing the previous Terra reference target, moving fable/Sol to T2/T3, using unversioned fable/opus aliases, and adding Astra as T1.

## Scope and invariants

- Agent Deck shared spawn/handoff model prose and example array; Grok fallback defaults across Desktop, Core, provider projection and container model config/catalog; matching README and tests. Model fields remain free text and explicit/user-configured selections retain precedence.
- Skill Market three explicit native parallel-tasks packages and their canonical versions/generated views. T1 Astra, T2 fable, T3 Sol, T4 opus; all xhigh. The user clarified that only table model targets move; all tier criteria, dispatch complexity rules, review thresholds, and other text stay byte-identical. Use the repository proposal preparation workflow with isolated local state, then apply its bounded diff to the requested sibling checkout. No submit, push, publication, or installed-skill mutation.
- Existing uncommitted reviewer defaults and generic multi-quota implementation remain preserved. Correct the earlier unsupported Astra-exclusive quota wording: official pricing documents no Astra-specific separate pool, and no live account response was inspected.
- Preserve all runtime permission/sandbox policies and the live host. No deep-review/simple-review, provider calls, native binding rebuild, app restart, installation, or commit/push of either requested checkout.

## Completed work

- Instructions, existing inventory and model call sites read; exact prompt assets inventoried/backed up.
- Implemented local model defaults/suggestions and prepared the three native package candidates; inspected and applied the verified proposal diff.
- Agent Deck focused validation passed 12 files / 149 tests and typecheck. Skill Market validation passed 149 tests and all three standalone Skill validators. Diff, links and hashes passed; broader app suite/build was not repeated for this bounded edit.
- Archived CHANGELOG_640 and its linked validation/source manifests. The sibling package source changes remain local and uncommitted in the requested checkout.

## Risks and unresolved questions

Real provider model availability is runtime/account-owned and is not inferred from the suggested strings. The original Data panel symptom remains unspecified. Astra independent quota availability is not established by generic rate-limit-map support. Live host activation needs separate exact-target authorization.

## Final record

[CHANGELOG_640](../../changelogs/recent-3-days/CHANGELOG_640_model-routing-and-grok-defaults.md) contains implementation, validation, size exceptions and delivery limits.
