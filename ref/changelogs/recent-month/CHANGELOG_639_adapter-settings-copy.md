---
changelog_id: 639
changed_at: 2026-09-04
---

# CHANGELOG_639_adapter-settings-copy: Align adapter settings descriptions

## Summary

The Claude Code, Codex CLI, and Grok Build settings pages now use the same description structure,
canonical product names, and user-facing configuration-path style.

## Changes

- Rendered terminal integration and in-app capability help from one shared sentence pattern for all
  three adapters, while retaining each adapter's actual configuration and Hook paths.
- Standardized the in-app asset terms as Skills, Agents, and MCP tools instead of mixing casing and
  provider-specific wording.
- Replaced the settings-page `$CODEX_HOME/config.toml` label with the approachable default path
  `~/.codex/config.toml`, matching the path style used for Claude Code and Grok Build.
- Added focused assertions for the shared template, canonical adapter names, and absence of the
  inconsistent `$CODEX_HOME` and `Grok Build CLI` labels.

## Validation

- Focused `AdapterConfigHelp` test: 3 tests passed.
- `pnpm typecheck` passed.
- `pnpm test` passed.
- `git diff --check` passed.

## Do Not Split Protection

No exception is required. The changed production component remains well below 500 lines.

## Notes

The README already uses the canonical Claude Code, Codex CLI, and Grok Build product names. Its
runtime-contract notation for an optional custom `CODEX_HOME` remains intentionally technical;
this change only makes the settings-panel copy consistent and approachable.
