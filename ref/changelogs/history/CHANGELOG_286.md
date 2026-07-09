# CHANGELOG_286: show adapter-specific permissions views

## Summary

The Session Detail permissions tab now switches by adapter. Claude-family sessions keep the existing Claude Code four-layer settings scan, while Codex sessions show Codex-side sandbox, fixed approval policy, MCP, and `~/.codex/config.toml` data.

## Changes

- Added a read-only Codex permission/config scanner for `~/.codex/config.toml`, app-managed Codex MCP servers, Agent Deck MCP injection settings, and effective sandbox display.
- Added dedicated Codex permission IPC/preload methods and kept the existing Claude `permission:scan-cwd` / `permission:open-file` contract unchanged.
- Updated `PermissionsView` to branch by session adapter:
  - Claude-family sessions still render merged allow/deny/ask/additionalDirectories from `.claude/settings*.json`.
  - Codex sessions render sandbox source, fixed `approvalPolicy=never`, skipped Git repo check, top-level model, Agent Deck MCP status, MCP server lists, and raw config text.
- Passed session adapter and Codex sandbox into the permissions tab from `SessionDetail`.

## Validation

- `pnpm exec vitest run src/main/permissions/__tests__/codex-scanner.test.ts`
- `pnpm exec vitest run src/main/permissions/__tests__/codex-scanner.test.ts src/main/codex-config/__tests__/toml-writer.test.ts src/main/codex-config/__tests__/agent-deck-mcp-injector.test.ts`
- `pnpm typecheck`
- `git diff --check`
