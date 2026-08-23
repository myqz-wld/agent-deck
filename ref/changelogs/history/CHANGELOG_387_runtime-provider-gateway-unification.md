---
changelog_id: 387
changed_at: 2026-07-23
---

# CHANGELOG_387_runtime-provider-gateway-unification: Unify runtime providers

## Summary

Agent Deck now uses one `adapter + provider + model + thinking` runtime contract across session
creation, Agents, collaboration, generators, handoff, issue resolution, recovery, restart, fork,
and live Session Detail controls. Deepseek is a Claude Gateway profile instead of an adapter, Codex
uses its native `model_provider`, and the Data page displays Grok quota information.

## Changes

### Claude Gateway profiles

- Removed `deepseek-claude-code` from the adapter registry, creation schemas, UI, CLI, prompts, and
  bundled reviewer inventory. There is no adapter alias or `--adapter deepseek` compatibility path.
- Added read-only discovery for `~/.claude/gateways/*.json`, with a built-in `deepseek` profile
  initialized from the one-time legacy settings migration.
- Resolved a selected Gateway to a settings file and passed it through the Claude SDK's
  per-query `options.settings`. Gateway credentials are never copied into Agent Deck settings,
  SQLite, logs, or a process-global session switch.
- Added Gateway-aware model aliases and native-fork transcript-root validation. Two Claude
  sessions can select different settings files without sharing runtime state.

### Unified runtime selection and persistence

- Added `runtime_provider` to sessions and migrated legacy Deepseek rows to
  `agent_id=claude-code`, `runtime_provider=deepseek`.
- Threaded provider through the New Session dialog and CLI, user and bundled Agent configuration,
  `spawn_session`, `hand_off_session`, Resolve in New Session, session handoff, Session Detail
  runtime controls, plan-review synthesis, restart, dormant recovery, and jsonl-loss recovery.
- Enforced runtime precedence as explicit input, Agent runtime/frontmatter, persisted session,
  application default, then adapter-native default.
- Required exact adapter and provider equality for native fork; no path silently changes a Claude
  Gateway or Codex `model_provider`.
- Added Codex provider discovery from top-level `model_provider` and `[model_providers.*]` entries
  in `~/.codex/config.toml`. Each Codex thread receives its own `config.model_provider` override.

### Summary and Continuation Context

- Replaced the mixed legacy generator provider fields with independent adapter, runtime provider,
  model, and thinking settings.
- Migrated legacy Deepseek generator selections to `claude-code` plus
  `summaryRuntimeProvider=deepseek` or
  `continuationCheckpointRuntimeProvider=deepseek`.
- Added provider discovery and validation to both settings sections while preserving the concurrent
  Grok generator work.

### Grok quota

- Replaced the former Deepseek quota slot with a Grok card in the Data page's shared provider quota
  pipeline.
- Reads Grok's own cached login transiently, requests the native billing snapshot, retries once
  through Grok authentication when necessary, and never persists or logs the credential.
- Displays percentage and billing-cycle reset data when available, including reset-only free-plan
  responses, with non-sensitive unavailable/error states.

### Prompt and migration cleanup

- Removed the bundled `reviewer-deepseek`; Deepseek reviews now require an explicit Claude provider
  and model selection.
- Updated Claude, Codex, and Grok application conventions plus both review skills so their adapter,
  provider, precedence, and fork semantics remain aligned.
- Preserved the legacy Deepseek settings file as an inert user-owned backup after creating
  `~/.claude/gateways/deepseek.json`; runtime discovery never consults the old adapter path.

## Validation

- Focused provider, lifecycle, UI, quota, migration, Gateway isolation, generator, and Hook tests
  passed.
- `pnpm typecheck`, the full Electron test suite, `pnpm build`, `pnpm logger:check`, and
  `git diff --check` passed.
- Prompt inventory hashes and both pre-edit backup manifests were verified.
- Legacy runtime references remain only in one-time database/settings migration tests and migration
  SQL; supported runtime lists contain exactly Claude Code, Codex CLI, and Grok Build.

## Do Not Split Protection

- New provider discovery, Gateway resolution, fork safety, Grok quota, and settings migration
  validation responsibilities live in focused modules.
- Changed production source files remain within the repository's 500-line guardrail.
- The concurrent Grok Hook/generator implementation remains recorded separately in
  `CHANGELOG_386_grok-generators-external-hooks.md`.

## Related records

- `PLAN_18_runtime-provider-gateway-unification.md`
- `CHANGELOG_386_grok-generators-external-hooks.md`
