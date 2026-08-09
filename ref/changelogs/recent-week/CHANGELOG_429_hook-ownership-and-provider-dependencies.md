---
changelog_id: 429
changed_at: 2026-08-03
---

# CHANGELOG_429_hook-ownership-and-provider-dependencies: Keep hooks idempotent and refresh provider dependencies

## Summary

Hook installation now replaces every command variant owned by the same adapter/event tag instead
of comparing the full generated command. This prevents command-shape upgrades from appending a
second external-session hook. The same delivery refreshes the bundled Grok runtime and the shared
MCP SDK while confirming the current Claude, Codex, Anthropic, and ACP packages are already at
their latest stable releases.

## Changes

### Hook ownership and migration

- Centralize hook ownership cleanup around the exact trailing
  `agent-deck-hook-v2-<adapter>-<event>` tag emitted by the command builder.
- Apply the shared cleanup to Claude Code, Codex CLI, and Grok Build installation and uninstall
  paths so relay-path, curl-safety, or wrapper changes remain idempotent.
- Preserve unrelated commands in mixed groups, commands without a string body, generic historical
  Agent Deck-looking tags, and user-owned hooks.
- Add regression coverage for duplicate Codex command variants, future command-shape uninstall,
  mixed-group preservation, trailing whitespace, and generic tag collisions.

### Provider dependencies and bundled CLIs

- Upgrade `@xai-official/grok` from `0.2.114` to `0.2.118`, including every platform package in
  the lockfile.
- Upgrade `@modelcontextprotocol/sdk` from `1.29.0` to `1.30.0` and refresh its transitive lockfile
  graph.
- Confirm `@anthropic-ai/claude-agent-sdk` `0.3.220`, `@anthropic-ai/sdk` `0.115.0`,
  `@openai/codex` `0.146.0`, and `@agentclientprotocol/sdk` `1.3.0` are already the latest stable
  registry versions.

## Validation

- User-level Claude, Codex, and Grok hook configurations parse successfully, have mode `0600`, and
  contain exactly one current command for each of their 16, 11, and 14 installed events; Codex
  trusted-state indexes were collapsed to the matching single group.
- Focused hook/config contract suite: 4 files and 29 tests passed.
- Full Electron-ABI suite: 449 files passed and 1 intentional live smoke skipped; 3,687 tests
  passed and 1 skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm verify:bundled-runtimes`, and `git diff --check` passed.
- Executable checks reported Claude Code `2.1.220`, Codex CLI `0.146.0`, and the decompressed
  bundled Grok payload `0.2.118`.

## Do Not Split Protection

- The three adapter installers intentionally share one ownership-tag helper; duplicating the rule
  per adapter would recreate the drift that allowed Codex command upgrades to append duplicates.

## Notes

- The `@xai-official/grok` npm trampoline prefers an independently installed `~/.grok/bin/grok`,
  which remains outside Agent Deck ownership. Agent Deck resolves and materializes its bundled
  platform payload directly, and that payload reports `0.2.118`.
- Main-process hook installer changes take effect in the application after the next normal restart.
- All repository changes remain unstaged and uncommitted.
