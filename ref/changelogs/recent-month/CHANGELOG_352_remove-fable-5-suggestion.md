---
changelog_id: 352
changed_at: 2026-07-09
---

# CHANGELOG_352_remove-fable-5-suggestion: Remove redundant fable-5 suggestion

## Summary

The `spawn_session.model` suggestion list now exposes only the stable `fable` Claude alias instead of listing both `fable` and `fable-5`.

## Changes

- Removed `fable-5` from the MCP model suggestion constant and model-field description.
- Synchronized the bundled Codex and Claude runtime prompts and README.
- Kept custom provider model IDs, existing `claude-fable-5` normalization, and historical session/token metadata support unchanged.

## Validation

- Spawn tool contract tests — 92 tests passed.
- `pnpm typecheck`
- `pnpm test` — 191 files and 2142 tests passed.
- `pnpm build`
- `git diff --check`
- Four-file backup manifest, paired-prompt alignment, and prompt-asset hash verification.

## Do Not Split Protection

None. This is a suggestion-list correction with no provider runtime behavior change.
