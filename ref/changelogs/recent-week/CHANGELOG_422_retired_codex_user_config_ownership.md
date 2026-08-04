---
changelog_id: 422
changed_at: 2026-07-31
---

# CHANGELOG_422_retired_codex_user_config_ownership: Retire Codex user-config ownership

## Summary

Agent Deck no longer retains the hidden settings and config-writer path for its retired Codex
external-MCP editor. It also no longer performs compatibility cleanup in native Codex configuration
or user skill roots. Existing user files are left byte-for-byte under Codex and user ownership.

## Changes

### Settings and config ownership

- Remove `codexMcpServers` from `AppSettings`, defaults, validation, and runtime apply dispatch.
- Delete the retired MCP serializer, parser, and marker replacement implementation.
- Treat persisted `codexMcpServers` as a removed settings key during startup migration.
- Keep user-authored Codex MCP configuration native to `~/.codex/config.toml`.

### User configuration boundaries

- Remove startup mutation of historical marker blocks in `~/.codex/config.toml`.
- Remove startup and settings mutation of historical marker blocks in `~/.codex/AGENTS.md`.
- Stop deleting the historical `~/.codex/skills/agent-deck/` directory.
- Keep application conventions and bundled skill mirrors under Agent Deck app userData.

### Permission view

- Remove the two obsolete “Agent Deck managed” MCP lists from the Codex configuration scanner and
  renderer.
- Keep the raw Codex configuration view and live Agent Deck MCP injection status.

## Validation

- Targeted Vitest coverage for read-only Codex config access, permission scanning, settings
  migration, renderer permission display, and bootstrap (89 tests passed).
- `git diff --check`.
- `pnpm typecheck` is currently blocked by two unrelated `profile` fixture/type mismatches in the
  concurrent runtime-profile migration.
- Full `pnpm test` reached 3,907 passing tests and one skipped test. Nine unrelated failures remain
  in the concurrent provider-to-profile migration: stale provider expectations, copy, and routing
  contracts.

## Do Not Split Protection

All changed production source files remain below 500 lines.

## Notes

- Agent Deck's own MCP server remains dynamically injected into Codex sessions and is unaffected.
- Native Codex configuration and user skill roots are no longer mutated by Agent Deck.
