# CHANGELOG_348: Provider-scoped thinking for summaries and Hand-off briefs

## Summary

Periodic summaries and Hand-off briefs can now set thinking effort for Claude, Deepseek, and
Codex. The settings UI exposes only the values supported by the selected provider, and each oneshot
runner passes the selected value through its own SDK field.

## Changes

### Settings and compatibility

- Both summary rows now enable the thinking selector for Claude and Deepseek instead of treating it
  as Codex-only.
- Codex options are `minimal / low / medium / high / xhigh / max / ultra`.
- Claude and Deepseek options follow Claude Code effort support:
  `low / medium / high / xhigh / max`. Claude Code does not expose `ultra` as an effort level, and
  it remains authoritative for model-specific downgrades.
- Switching from Codex to a Claude-family provider atomically maps `minimal` to `low` and `ultra`
  to `max`; levels shared by both providers are preserved. The main-process resolver applies the
  same mapping to older retained settings.
- The shared settings type now uses the existing session-thinking SSOT instead of a duplicated
  four-value union.

### Oneshot runners

- Claude and Deepseek summary / Hand-off calls pass valid settings through the Claude Agent SDK
  `effort` option. Unknown enum values never reach the SDK.
- Codex summary / Hand-off calls accept the complete current Codex reasoning range through
  `modelReasoningEffort`.
- These values affect only the independent summary or Hand-off oneshot call; they do not rewrite
  provider configuration or mutate the model / thinking level of the session being summarized.

### Documentation

- README settings documentation now lists the provider-scoped value sets and keeps Claude Code's
  `max` ceiling distinct from Codex `ultra`.

## Validation

- Focused Claude/Deepseek and renderer tests passed: 2 files / 12 tests.
- Focused Codex oneshot tests passed: 1 file / 12 tests.
- `pnpm test` passed: 190 files / 2110 tests.
- `pnpm typecheck` passed.
- `pnpm build` passed.
- `git diff --check` passed.
- README backup manifest, prompt-asset inventory JSON, and pre/post-edit hashes were validated.
