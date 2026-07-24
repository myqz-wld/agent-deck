---
plan_id: PLAN_18
title: Runtime Provider / Gateway unification
status: completed
created_at: 2026-07-23
updated_at: 2026-07-23
completed_at: 2026-07-23
base_branch: main
base_commit: 090724949c19a0750f6a49f5aa18eef1323d1599
related_changelog: CHANGELOG_387
---

# PLAN_18_runtime-provider-gateway-unification: One runtime selection contract

## Goal and invariants

- Use `adapter + provider + model + thinking` everywhere a runtime is selected.
- Interpret Claude provider as an isolated Gateway settings profile and Codex provider as native
  `model_provider`; reject provider for Grok Build.
- Keep credentials in native user-owned configuration only and never switch a Gateway by mutating
  global `process.env`.
- Preserve provider through every session lifecycle path and require exact provider equality for a
  native fork.
- Remove all old-adapter creation and compatibility behavior after one-time persisted-data and
  settings migrations.
- Preserve the concurrent Grok Hook/generator work in the shared worktree.

## Confirmed design decisions

- Discover Claude profiles from `~/.claude/gateways/*.json`; pass the resolved file through
  `options.settings` on each SDK query.
- Discover Codex provider suggestions from native TOML while keeping free-text provider ids
  provider-authoritative.
- Migrate old Deepseek sessions to Claude plus `provider=deepseek` and initialize the local
  `deepseek` Gateway settings file from the legacy user file.
- Keep only `reviewer-claude`, `reviewer-codex`, and `reviewer-grok`; selecting Deepseek is an
  explicit runtime choice, not an Agent slot.
- Split summary and Continuation Context generator settings into independent adapter, provider,
  model, and thinking fields.
- Replace the Data page's Deepseek quota position with a native Grok billing snapshot.

## Completed checklist

- [x] Add provider-neutral runtime types, validation, and precedence.
- [x] Add session `runtime_provider` persistence and v046 migration.
- [x] Add Claude Gateway discovery, initialization, isolated settings resolution, and fork safety.
- [x] Add Codex model-provider discovery and per-thread config override.
- [x] Thread provider through new session, CLI, Agents, spawn, handoff, issue resolution, and
      Session Detail controls.
- [x] Preserve provider through resume, dormant recovery, restart, app restart, jsonl fallback, and
      native fork.
- [x] Split summary and Continuation Context runtime settings and migrate legacy selections.
- [x] Resolve plan-review synthesis through the persisted Gateway profile.
- [x] Remove the old adapter, reviewer, UI choices, schemas, tests, and prompt references.
- [x] Add Grok quota collection and Data page coverage.
- [x] Refresh documentation, prompt inventory, backups, changelog, and plan records.
- [x] Complete focused and full validation.

## Validation and completion

- Focused tests cover simultaneous per-session Claude settings paths, Codex model-provider
  overrides, provider precedence, UI pass-through, handoff/fork equality, migration, recovery,
  summary/checkpoint selection, plan review, and Grok quota.
- Full typecheck, Electron test suite, build, logger, whitespace, review-expiry, prompt-asset, and
  changed-source file-size checks passed.
- Local legacy Deepseek settings were migrated to `~/.claude/gateways/deepseek.json` with private
  permissions; the old file remains inert and is not consulted at runtime.

## Final status

Completed on 2026-07-23. Supported session adapters are now exactly `claude-code`, `codex-cli`, and
`grok-build`. Provider is a first-class persisted runtime dimension for Claude and Codex, and no
runtime compatibility alias can recreate or resume the removed Deepseek adapter.
