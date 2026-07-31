---
changelog_id: 421
changed_at: 2026-07-31
---

# CHANGELOG_421_spawn-session-model-suggestions: Retire stale spawn model suggestions

## Summary

`spawn_session` no longer advertises `gpt-5.4`, `gpt-5.5`,
`deepseek-v4-pro[1m]`, or `deepseek-v4-flash` in its maintained model suggestions, and
regression coverage also keeps `deepseek-v4-pro` out of that list. The model field remains a
trimmed free-text override, so explicit custom model ids continue to pass through to the selected
provider for validation.

## Changes

### Model suggestions

- Remove `gpt-5.4`, `gpt-5.5`, `deepseek-v4-pro[1m]`, and `deepseek-v4-flash` from
  `SPAWN_SESSION_MODEL_VALUES`.
- Keep `deepseek-v4-pro` absent from the maintained list.
- Remove the two retired GPT suggestions from the shared MCP model-field description.
- Preserve the current `gpt-5.6-*`, Claude, and Grok suggestions.

### Contract coverage

- Assert that all five retired names remain absent from the maintained list and field guidance.
- Preserve tests proving that explicit provider-specific and custom model strings still pass
  through unchanged.

## Validation

- `pnpm vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` (95 tests passed)
- `pnpm typecheck`
- `env NODE_ENV=test pnpm test` (480 files passed, 1 skipped; 3,931 tests passed,
  1 skipped)
- `git diff --check`

## Do Not Split Protection

Both changed production source files remain below 500 lines. The existing larger test fixture is
exempt from the source-file guardrail.

## Notes

- No database migration is required.
- README and bundled Claude/Codex/Grok runtime instructions do not duplicate these model names and
  remain unchanged.
- Prompt/schema assets were backed up under
  `.prompt-asset-improver/local/backups/20260731T073857Z/` before editing.
