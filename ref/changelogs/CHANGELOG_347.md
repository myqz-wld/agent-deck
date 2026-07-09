# CHANGELOG_347: Preserve model slugs and synchronize session reasoning metadata

## Summary

Fixed model normalization that collapsed semantic provider slugs such as `gpt-5.6-sol` into
`gpt-5.6`, repaired affected historical GPT token buckets, and made Codex/Claude session model and
thinking metadata reflect the strongest provider-authoritative value available without changing
global provider configuration.

## Changes

### Model identity and historical token buckets

- GPT family/version parsing now requires a complete bare-version match. Semantic suffixes such as
  `sol`, `terra`, `luna`, `mini`, custom provider tags, and preview tags remain part of the model id.
- Only recognized terminal variants (`thinking`, effort levels, `1m`) are stripped iteratively;
  matching words in the middle of a provider slug are preserved.
- Claude normalization now uses an exact known-family/version/date grammar. Eight-digit snapshots
  still aggregate with their base family/version, while semantic suffixes fall back to the full id.
- Added v036 to rebuild historical GPT `token_usage.model_bucket` values from `model_raw`. The SQL
  is GPT-only, idempotent, preserves the established `gpt-5-5` -> `gpt-5.5` spelling equivalence,
  and does not guess at historical custom Claude buckets.

### Codex session effort

- Added a section-aware, read-only top-level `model_reasoning_effort` reader for Codex config and
  expanded the shared Codex effort type to `minimal / low / medium / high / xhigh / max / ultra`.
- Resolution is session-scoped:
  - new session: explicit value > safe unprofiled top-level config hint > provider default;
  - resume: explicit value > persisted session value > provider default.
- A historical resumed session with `thinking = null` does not inherit today's global setting.
- Config-derived hints are persisted for display but are not forced into ThreadOptions; Codex keeps
  authority over profile/config layer precedence. Active profiles or per-session config overrides
  conservatively leave the display unset rather than recording a misleading base value.
- MCP spawn validation and Codex custom-agent TOML now accept `max` and `ultra`; Claude-family
  adapters remain limited to `low / medium / high / xhigh / max`.

### Claude and Deepseek runtime calibration

- Claude SDK `system/init.model` is now the sole runtime source for the main session model.
  Assistant-frame models remain token-accounting inputs only and cannot overwrite the session model.
- Programmatic `Stop` / `StopFailure` observers record the provider-reported actual effort after any
  silent downgrade. The callbacks always return `{}` and cannot alter stop behavior.
- Runtime observations arriving before the DB row are retained in `InternalSession` and used by all
  finalization paths; existing rows receive best-effort updates plus `session-upserted` refreshes.
- Deepseek's Claude-compatible aliases are mapped back to configured Deepseek model ids without
  retaining credentials or the full provider environment.
- Model priority is explicit > resumed concrete model > provider profile default > SDK default.

### Session scope and documentation

- `spawn_session.model` and `spawn_session.thinking` are documented as target-session-only values.
  They do not write `~/.codex/config.toml`, Claude settings, or Agent Deck global defaults.
- README now documents full semantic model-id preservation and adapter-specific effort support.

## Validation

- `pnpm test` passed: 189 files / 2101 tests, including real Electron-ABI SQLite migrations.
- Focused adapter/config/MCP regression run passed: 57 files / 563 tests.
- Focused v036 run passed: 3 files / 49 tests.
- Post-review profile/subagent guards passed: 3 files / 43 tests.
- `pnpm typecheck` passed.
- `pnpm build` passed.
- `git diff --check` passed.

## Do Not Split

- `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts` (669 LOC): the new behavior is
  a six-line dispatch at the existing authoritative SDK message boundary; all new persistence logic
  was already extracted into `runtime-metadata-sync.ts`.
- `src/main/adapters/claude-code/sdk-bridge/index.ts` (585 LOC): only the one-line distinction between
  explicit model and provider-profile default changed; splitting the existing facade is unrelated.
- `src/main/agent-deck-mcp/__tests__/tools.test.ts` (2510 LOC): only shared schema expectations and
  adapter-boundary cases changed; splitting its shared integration fixture is a separate refactor.
