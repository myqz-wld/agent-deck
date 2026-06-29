# resources/

Source directory for app runtime resources. `package.json` `build.extraResources` copies this directory to `.app/Contents/Resources/`; the main process then reads resources by adapter and injects them into SDK sessions.

This document records only resource paths, loading behavior, and paired-boundary rules for locating runtime resources during packaging and injection.

## Packaging Paths

| Source directory | Packaged directory | Purpose |
|---|---|---|
| `resources/bin` | `.app/Contents/Resources/bin` | CLI wrapper and helper scripts |
| `resources/claude-config` | `.app/Contents/Resources/claude-config` | Claude Code / Deepseek (Claude Code) app conventions and plugin resources |
| `resources/codex-config` | `.app/Contents/Resources/codex-config` | Codex app conventions, custom-agent TOML, and skill resources |
| `resources/sounds` | `.app/Contents/Resources/sounds` | App notification sounds |

Path routing: dev (`pnpm dev`) reads the `<repo>/resources/*` source directories directly; prod reads the `.app/Contents/Resources/*` copies. `icon.png` / `icon.ico` are electron-builder inputs (`mac.icon`), are not included in extraResources, and are not loaded at runtime.

## claude-config/

The Claude Code adapter uses this resource root. Deepseek (Claude Code) reuses the same agents / skills / `CLAUDE.md` and overlays provider env through `~/.agent_deck/.deepseek/settings.json`.

- `CLAUDE.md`: Appended to the end of the preset system prompt through Claude SDK `systemPrompt.append`, after user / project / local `CLAUDE.md`. The user copy saved by the settings panel is written to `<userData>/agent-deck-claude.md`; when present, it overrides the bundled file.
- `agent-deck-plugin/`: Local plugin source used by the Claude SDK `plugins` field. At runtime it is mirrored to `<userData>/agent-deck-plugin/` and resource placeholders are replaced; the mirror is pruned by `injectAgentDeckClaudeSkills` / `injectAgentDeckClaudeAgents` for the `skills/` / `agents/` subdirectories before being handed to the SDK scanner.
- `agent-deck-plugin/agents/reviewer-claude.md`: Claude Code reviewer teammate body.
- `agent-deck-plugin/agents/reviewer-deepseek.md`: Deepseek reviewer teammate body loaded through the Claude Code resource root.
- `agent-deck-plugin/skills/*/SKILL.md`: Claude Code-side `agent-deck:*` skills.

## codex-config/

The Codex adapter uses this resource root. Codex app-server has no Claude SDK `plugins[]` field, so its injection path differs from the Claude side.

- `CODEX_AGENTS.md`: After resource placeholder replacement, injected into in-app Codex sessions through app-server `developerInstructions`. The user copy saved by the settings panel is written to `<userData>/agent-deck-codex-agents.md`; when present, it overrides the bundled file. If the bundled file is missing, loading fails explicitly and does not fall back to the claude-config side.
- `agent-deck-plugin/agents/reviewer-codex.toml`: Official Codex custom-agent TOML. The bundled-assets / spawn loader scans it for `spawn_session(agentName)` routing. When `injectAgentDeckCodexAgents=false`, the spawn loader skips the bundled root, but project / user Codex agents remain available.
- `agent-deck-plugin/skills/*/SKILL.md`: After resource placeholder replacement, mirrored into the Codex skills extraRoot under app userData and injected into in-app Codex sessions through app-server `skills/extraRoots/set`; it is not written to the user-level `~/.codex/skills/agent-deck/`.

## Paired Boundaries

- App environment conventions: protocol semantics in `resources/claude-config/CLAUDE.md` and `resources/codex-config/CODEX_AGENTS.md` must stay aligned; adapter tool differences should be written according to each adapter's execution model.
- Reviewer bodies: `reviewer-claude.md`, `reviewer-deepseek.md`, and `reviewer-codex.toml` must align on role, input contract, output format, and failure handling; do not copy another side's tool instructions merely for mirrored synchronization.
- Skills: Claude skills live in `resources/claude-config/agent-deck-plugin/skills/`, and Codex skills live in `resources/codex-config/agent-deck-plugin/skills/`. Same-name skills must align on triggers and target behavior, while execution steps should follow each adapter's tool capabilities.
- Packaged resources must be self-contained: app conventions, reviewer agents, and skills must remain fully usable when no user-customized agents / skills exist.
