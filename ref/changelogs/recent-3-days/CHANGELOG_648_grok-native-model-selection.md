---
changelog_id: 648
changed_at: 2026-09-22
---

# Grok Native Model Selection

## Summary

Remote Grok now follows explicit session selection, native user configuration, then the CLI
default. Remove the generated fixed-model broker profile and duplicate model catalog while
preserving credential isolation. Correct live model-switch acknowledgement handling.

## Changes

- Read Grok's native `[models].default` and `default_reasoning_effort` with the TOML parser in
  local session defaults and sanitized Worker projection. Do not translate obsolete top-level keys.
- Carry only a bounded default selector through the trusted container launch contract into
  `GROK_DEFAULT_MODEL`. With no configured selector, leave the CLI default unset. Explicit ACP
  session metadata continues to take precedence.
- Remove the generated `agent-deck-broker` model profile, fixed model IDs, and local catalog.
  Let native discovery and model metadata determine available models and inference backends.
- Authorize exact method/path pairs in the shim, Core broker, credential injector, and HTTPS
  upstream. Add only `GET /v1/models` to the two existing inference POST routes. Use the fixed
  CLI OAuth catalog endpoint and Core-owned token-auth header; GET egress has no request body.
- Parse the current Grok `_meta.model.Ok` acknowledgement for live model changes, retaining
  bounded failure handling and compensating persistence rollback. Use the canonical reported
  ID for runtime identity and retain the requested selector separately. Remove the unsupported
  top-level model/effort echo assumption without accepting the old response shape.
- Update the README, protocol fixtures, and behavior tests. Preserve previously authorized
  dependency/model-name changes and explicit reviewer model selection.

## Validation

- `pnpm typecheck`: architecture boundaries and both TypeScript projects passed.
- `pnpm test`: 1,033 files / 6,410 tests passed; two files / three opt-in tests skipped.
- Real Grok 1.0.41 ACP probes through the production proxy and Core broker passed for omitted
  selection, configured defaults, explicit override, native default alias, unavailable discovery,
  and live controller model switch/reset persistence. Both UDS and direct broker transports ran
  against a fake HTTPS upstream; no authenticated provider inference was performed.
- `pnpm dist:mac`: reproducible headless build, application build, DMG generation, and packaged
  Worker sandbox checks passed. Expected sandbox denial verified the outside-file boundary.
- Actual ASAR and Worker artifacts contain the new selection/acknowledgement logic and the
  refreshed Claude, Codex, Grok, Anthropic, and ACP package versions. First-party archive members,
  resources, source maps, and Worker binaries passed personal-path checks; local maintenance
  files and raw diagnostics are excluded. `hdiutil verify` passed.
- The Electron SQLite binding hash remained unchanged. `git diff --check` passed. Active source
  and runtime assets contain no old broker profile, fixed local catalog, or unused suggestion list.

## Do Not Split Protection

None. Modified production sources remain below 500 lines; the dependency lockfile is exempt.

## Notes

- Native endpoint and acknowledgement behavior was cross-checked with the official Grok
  [model discovery implementation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/remote/model_source/oai.rs)
  and [model switch handler](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/handlers/model_switch.rs),
  then exercised with the pinned binary and synthetic credentials.
- Custom endpoint profiles and credentials are not copied into the remote container. Remote
  defaults must select native model IDs or CLI default aliases.
- The installed app and deployed runtimes remain unchanged. Installation/restart requires exact
  host-runtime approval; remote rollout requires matching Core and rebuilt container shim/image.
- Related: [PLAN_55](../../plans/recent-3-days/PLAN_55_grok-native-model-selection.md),
  [CHANGELOG_647](CHANGELOG_647_model-names-native-defaults.md).
