# CHANGELOG_296 - Codex external hooks

## Summary

- Added Codex CLI hook installation, status, uninstall, and hook routes so external terminal `codex` sessions can appear in Agent Deck as read-only hook-channel sessions.
- Added Codex hook translation for session start, pre/post tool use, terminal permission waits, post-compact, and stop events; terminal permission waits mark the session as waiting without creating an in-app approval row.
- Made hook IPC/preload/Settings UI adapter-aware while keeping old Claude-only calls compatible.
- Cleaned the local Codex user config by removing Codex app-injected Desktop/node_repl/Anthropic environment blocks from `~/.codex/config.toml` and replacing stale Agent Deck entries in `~/.codex/hooks.json` with Codex-specific routes.
- Updated README and empty-state copy to describe Codex hook + SDK dual-channel behavior.

## Validation

- `pnpm typecheck`
- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/hook-installer.test.ts src/main/adapters/codex-cli/__tests__/hook-translate.test.ts`
- `node -e "JSON.parse(require('fs').readFileSync(process.env.HOME + '/.codex/hooks.json','utf8')); console.log('hooks json ok')"`
- `rg -n "hook/(pretooluse|posttooluse|sessionstart|postcompact|stop)|matcher\\\": \\\"\\*\\\"|mcp_servers\\.node_repl|ANTHROPIC_|\\[desktop\\]" ~/.codex/config.toml ~/.codex/hooks.json || true`
- `node_modules/.bin/codex doctor` loaded `~/.codex/config.toml` successfully (`config.toml parse ok`) but exited 1 for existing environment notes: local package/global install mismatch, update target mismatch, and `TERM=dumb`.
- Full `pnpm test` currently has an unrelated existing failure in `src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts`; tracked as issue `5dada7b9-a327-492e-a98c-af9642ed65fb`.
