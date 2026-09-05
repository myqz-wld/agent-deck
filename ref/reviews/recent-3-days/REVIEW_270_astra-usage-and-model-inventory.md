---
review_id: 270
reviewed_at: 2026-09-04
baseline_commit: 365dabc0eab9f328ac9fc0cbd6938ecef4ca5a7d
coverage_kind: bounded-bug-fix-and-model-inventory
expired: true
expiry_reason: "Scoped uncommitted implementation verification and read-only model inventory; no project-wide or whole-file exemption."
---

# Multiple Codex quota groups and model-name inventory

Codex account quota projection now preserves all quota groups supplied by the provider alongside the default Codex quota. This generic capability does not establish a separate Astra allowance. Bundled reviewer defaults are `gpt-6-astra` / `xhigh` and `grok-4.6` / `high`; only their model values changed. The requested model-name inventory is [available here](astra-usage-model-inventory/model-name-inventory.md), and [PLAN_49](../../plans/recent-3-days/PLAN_49_astra-usage-and-model-inventory.md) records the completed scope.

## Quota clarification after user feedback

The earlier user-facing claim of an "Astra-exclusive quota" was unsupported and is withdrawn. [Official pricing](https://learn.chatgpt.com/docs/pricing), fetched on 2026-09-04 local time, lists Astra usage estimates and consumption rates but does not identify a separate Astra quota pool; it explicitly names GPT-5.3-Codex-Spark as having a separate limit. Generic `rateLimitsByLimitId` support alone cannot prove Astra-specific account behavior. The original Data panel symptom remains unconfirmed.

This record preserves the earlier bounded implementation and inventory snapshot. The user's subsequent model-list, Grok-default and Skill Market table decisions are tracked separately in CHANGELOG_640.

## Finding and repair

**MEDIUM — model-specific Codex quota windows were discarded.** `buildCodexUsageSnapshot` selected only one entry from `rateLimitsByLimitId`, normally `codex`. With multiple quota groups present in a synthetic response, the additional values never reached the Data panel. Astra was only a test fixture label; no real account payload established that quota group. The Remote DTO also allowed only unique `current`/`weekly` ids and at most four windows, so merely appending the missing pair would reject the result and duplicate React keys.

The producer now collects distinct provider quota ids, gives the indexed response precedence over a duplicate default snapshot, retains a legacy default absent from the map, and skips groups with no displayable data. Additional quotas use their provider label or id in window labels. No model-name allowlist or fixed Astra-only branch was added.

An optional `quotaId` identifies a model-specific window. The Remote parser bounds quota ids and labels, permits at most 64 windows, and enforces uniqueness by quota id plus period. Existing unscoped default payloads remain valid. The shared Local/Remote Data panel uses the same composite React key so refresh or removal cannot confuse one quota with another.

The raw symptom clarification was not answered during implementation. Source inspection isolated the concrete quota-projection gap above; no live Astra account payload was read. Existing token normalization already accepts the full `gpt-6-astra` identity and its reasoning suffixes; regressions verify that behavior, token totals and rate display without introducing guessed aliases or modifying historical usage rows.

## Reviewer defaults and inspection-only scope

- `reviewer-codex.toml`: `gpt-5.6-sol` → `gpt-6-astra`, `model_reasoning_effort = "xhigh"` preserved.
- `reviewer-grok.md`: `grok-4.5` → `grok-4.6`, `effort: high` preserved.
- Reviewer bodies and Claude counterpart are unchanged. Explicit runtime arguments and user overrides retain their existing precedence. [Prompt backup/validation evidence](astra-usage-model-inventory/prompt-asset-validation.md) records the authorized scope and original hashes.
- Spawn/handoff suggestion text and the separate example array still list the three GPT 5.6 variants and Grok 4.5. Actual model arguments remain free text. Generic Grok 4.5 defaults and the shim's real model catalog are enumerated in the inventory, without modification.
- The sibling Skill Market checkout was read-only. Of 15 standalone and 30 plugin Skills, only the three byte-identical `parallel-tasks` bodies prescribe concrete model reference targets. Related generic model boundaries and template placeholders are documented separately. No deep-review/simple-review Skill or reviewer delegation was used.

## Validation

- Focused: 10 files / 96 tests passed. New cases cover default plus Astra quotas, Astra-only data, legacy fallback preservation, duplicate quota ids, arbitrary future quota names, missing metrics, DTO bounds/uniqueness, Core endpoint projection, renderer refresh/removal, and unchanged reasoning fields.
- `pnpm typecheck`: architecture checks and Node/Web compilation passed.
- `pnpm run test --maxWorkers=1 --minWorkers=1`: 1,024 files / 6,346 tests passed; two files / three platform or opt-in cases skipped. No new skipped test or native rebuild.
- `pnpm build`: main/preload/renderer and build metadata generation passed. The installed/running application was not changed.
- All 12 changed source/test/assets remain below 500 lines. The existing SQLite binding SHA-256 was unchanged. A test-only ambiguous UI text query was corrected before the final focused/full runs.
- [Validation metadata](astra-usage-model-inventory/validation.json), [source manifest](astra-usage-model-inventory/source-manifest.json), and sanitized logs in the same directory preserve exact evidence.

```review-scope
resources/codex-config/agent-deck-plugin/agents/reviewer-codex.toml
resources/grok-config/agent-deck-plugin/agents/reviewer-grok.md
src/contracts/usage.test.ts
src/contracts/usage.ts
src/hosts/server-core/usage-runtime.test.ts
src/main/adapters/__tests__/provider-usage-codex-quotas.test.ts
src/main/adapters/provider-usage.ts
src/main/codex-config/__tests__/bundled-reviewer-runtime.test.ts
src/renderer/components/data-panel/DataPanelView.astra.test.tsx
src/renderer/components/data-panel/DataPanelView.tsx
src/shared/__tests__/model-normalize.test.ts
src/shared/types/provider-usage.ts
```

## Residual risk and next decisions

Real provider availability and account quota data were not queried. Main-process changes require the next approved restart/release to affect the running app. Remote quota support requires the updated node and client; old payloads remain accepted by the new parser, but older clients are not claimed to understand the new quotaId field. No database migration, installed asset replacement, commit, push or deployment occurred.

The user will decide which spawn examples, generic Grok defaults/shim model entries, and Skill Market tier references should change next. These are an inventory for user direction, not additional approved edits.
