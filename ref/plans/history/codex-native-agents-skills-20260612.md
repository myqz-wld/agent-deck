---
plan_id: codex-native-agents-skills-20260612
status: completed
created_at: 2026-06-12
base_commit: 166fdb61a55985ae967ca99231aaad2b2f23923b
worktree_path: /Users/wanglidong/Repository/agent-deck
---

# Codex Native Agents And Skills

## Goal

Align Agent Deck's Codex-side resources with current Codex capabilities:

- In-app Codex SDK sessions receive Agent Deck runtime guidance through app-server `developerInstructions`, not by appending to the user's `~/.codex/AGENTS.md`.
- Codex reviewer agents use official custom-agent TOML files instead of Agent Deck-only markdown bodies where practical.
- `spawn_session(agentName=...)` loads real Claude/Codex agents from the sources their adapters support, including Codex personal and project custom agents.
- Settings / Assets Library can create and inspect Codex custom agents.
- Re-evaluate Codex skills installation: prefer native app-server/plugin/extra-root loading over copying bundled skills into user-level `~/.codex/skills/agent-deck/` when the runtime supports it.

## Confirmed Evidence

- Codex 0.139.0 app-server `thread/start` and `thread/resume` expose `developerInstructions`; `turn/start` does not.
- Codex 0.139.0 app-server `thread/start`/`thread/fork` expose `threadSource`, but no public `agentName`/`agent_path` selection parameter.
- Official Codex custom agents are standalone TOML files under `~/.codex/agents/` and `.codex/agents/`, with required `name`, `description`, and `developer_instructions`.
- Official custom agent TOML may include normal `config.toml` keys such as `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, and `skills.config`.
- Official docs describe Codex subagent orchestration as a parent Codex workflow capability; Agent Deck `spawn_session` starts independent SDK sessions, so it must use the app-server fields exposed for starting a thread rather than assuming an unexposed native agent selector.
- Claude Agent SDK exposes native `agent` plus programmatic `agents` options, so Agent Deck can launch Claude-family `spawn_session(agentName)` through SDK-native agent selection instead of prompt prefixing.
- Codex app-server supports `skills/extraRoots/set`; in-app Codex sessions can receive bundled Agent Deck skills from an app-owned mirror without copying them into user-level `~/.codex/skills/agent-deck/`.

## Design Decisions

- Do not write Agent Deck Codex baseline into user `~/.codex/AGENTS.md` by default. Keep the user's file untouched except for backward-compatible cleanup of historical Agent Deck marker blocks.
- For Agent Deck-created Codex sessions, combine the active Agent Deck Codex baseline with optional custom-agent developer instructions and pass the result as app-server `developerInstructions`.
- For bundled Codex reviewer agents, store them as TOML custom-agent files in Agent Deck's managed resource/config area and load them through the same TOML parser used for user/project agents.
- `spawn_session(agentName)` source precedence:
  1. Adapter-native bundled Agent Deck agent for the target adapter.
  2. Project-scoped agent under target cwd (`.claude/agents` for Claude-family if supported by SDK behavior; `.codex/agents` for Codex).
  3. User-scoped agent (`~/.claude/agents`, `~/.codex/agents`).
  4. Built-in Codex agent names (`default`, `worker`, `explorer`) only when the app-server can represent them; otherwise document unsupported selection.
- Bundled Agent Deck reviewer names must remain protected from accidental user override unless the user chooses another name.
- Claude-family `spawn_session(agentName)` uses SDK `agent`/`agents` with bundled/project/user `.claude/agents/<name>.md`; Codex `spawn_session(agentName)` maps TOML `developer_instructions`, `model`, `model_reasoning_effort`, `sandbox_mode`, and other config keys onto supported app-server fields.

## Checklist

- [x] Verify current Codex app-server schema and official docs for developerInstructions, custom agents, and skills.
- [x] Replace the earlier partial Codex custom-agent parser with a loader that handles bundled/project/user TOML sources and tracks source path/scope.
- [x] Convert Codex bundled reviewer asset from markdown body to TOML custom-agent resource, update scans/tests, and preserve reviewer behavior.
- [x] Route Codex `spawn_session(agentName)` through custom-agent config merging instead of prompt-prefix injection.
- [x] Add project-scoped Codex agent discovery from target cwd.
- [x] Add Claude-family project/user agent discovery and route through SDK-native `agent`/`agents`.
- [x] Add Settings / Assets Library create/edit/view/delete support for Codex TOML agents.
- [x] Stop syncing Agent Deck Codex baseline to user `~/.codex/AGENTS.md`; use app-server `developerInstructions` for in-app sessions.
- [x] Spike `skills/extraRoots/set` / config alternatives and stop copying bundled Codex skills into user `~/.codex/skills/agent-deck/` for in-app sessions.
- [x] Update README/resources docs, MCP descriptions, changelog, and tests.
- [x] Validate with full typecheck, targeted/full vitest, build, and diff checks.

## Risks

- App-server does not expose a direct agent-name thread-start parameter. Treating custom-agent TOML as a config layer is the closest exposed mechanism for Agent Deck-created top-level sessions.
- Removing `~/.codex/AGENTS.md` sync may affect external Codex CLI sessions launched outside Agent Deck. If external CLI compatibility is still desired, it should become an explicit compatibility toggle, not the app-internal default.
- Skills native loading may be process-scoped rather than durable. If so, copying to a managed user-level directory may remain necessary for external CLI compatibility.

## Outcome

Completed. The implementation now uses native Claude/Codex agent sources for `spawn_session(agentName)`, injects Codex Agent Deck guidance per in-app session instead of writing user-level `AGENTS.md`, loads bundled Codex skills through app-server extra roots, exposes Codex TOML agents in the Assets Library, and updates MCP/settings documentation.

## Validation

- `pnpm typecheck` passed.
- Targeted Vitest set passed, including spawn routing, MCP tools, Claude/Codex custom-agent loaders, app-server config merge, thread options, query options, and bundled asset scanning.
- `pnpm test:node` passed: 131 files passed, 16 skipped; SQLite-backed tests skipped under system Node because the local `better-sqlite3` binding is built for Electron ABI, which is the repository's existing test-script behavior.
- `pnpm build` passed.
- `git diff --check` passed.
