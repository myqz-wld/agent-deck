# resources/

Source directory for app runtime resources. `package.json` `build.extraResources` copies this directory to `.app/Contents/Resources/`; the main process then reads resources by adapter and injects them into SDK sessions.

This document records only resource paths, loading behavior, and paired-boundary rules for locating runtime resources during packaging and injection.

## Packaging Paths

| Source directory | Packaged directory | Purpose |
|---|---|---|
| `resources/bin` | `.app/Contents/Resources/bin` | CLI wrapper and helper scripts |
| `resources/claude-config` | `.app/Contents/Resources/claude-config` | Claude Code / Deepseek (Claude Code) app conventions and plugin resources |
| `resources/codex-config` | `.app/Contents/Resources/codex-config` | Codex app conventions, custom-agent TOML, and skill resources |
| `resources/grok-config` | `.app/Contents/Resources/grok-config` | Grok Build ACP baseline, plugin agents, and skills |
| `resources/sounds` | `.app/Contents/Resources/sounds` | App notification sounds |

Path routing: dev (`pnpm dev`) reads the `<repo>/resources/*` source directories directly; prod reads the `.app/Contents/Resources/*` copies. `icon.png` / `icon.ico` are electron-builder inputs (`mac.icon`), are not included in extraResources, and are not loaded at runtime.

## Immutable assets and runtime overrides

Packaged app conventions, Agents, and Skills are immutable runtime resources. The Assets Library
may attach an app-owned runtime delta to a bundled Agent without editing this directory:

- Claude/Deepseek, Codex, and Grok bundled Agents may override model and thinking.
- Codex bundled Agents may additionally override the native `model_provider` identifier.
- Reset removes the whole app-owned delta and exposes the packaged Agent defaults again.
- Bundled Skills have no runtime override. User and project Agents remain owned by their native
  adapter directories and do not consume bundled-Agent deltas.

Provider endpoints, credentials, and alias definitions stay in each adapter's native configuration.
The resource layer neither copies those definitions nor writes user-level Claude, Codex, or Grok
configuration.

## claude-config/

The Claude Code adapter uses this resource root. Deepseek (Claude Code) reuses the same agents / skills / `CLAUDE.md` and overlays provider env through `~/.agent-deck/.deepseek/settings.json`.

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

## grok-config/

The Grok Build adapter uses this resource root through the official ACP v1 `session/new` / `session/load` metadata surface.

- `GROK_AGENTS.md`: Injected as an extending ACP `_meta.agentProfile` object when the Grok app-conventions switch is enabled.
- `agent-deck-plugin/`: App-bundled Grok plugin containing `reviewer-grok` and the Agent Deck review skills.
- Grok accepts a whole plugin directory, while Agent Deck exposes independent Skills and Agents switches. At runtime the selected subdirectories are copied to an app-owned mirror under `<userData>/grok-plugin-profiles/`, and that mirror is passed through ACP `_meta.pluginDirs`.
- The mirror contains only bundled Agent Deck resources. Agent Deck does not write `~/.grok/config.toml`, `~/.grok/AGENTS.md`, or user plugins.
- The Grok binary is not part of `extraResources`; Settings may point to an installed binary, otherwise the adapter resolves `grok` from the user shell `PATH`.

## Paired Boundaries

- App environment conventions: protocol semantics in `resources/claude-config/CLAUDE.md`, `resources/codex-config/CODEX_AGENTS.md`, and `resources/grok-config/GROK_AGENTS.md` must stay aligned; adapter tool differences should be written according to each adapter's execution model.
- Reviewer bodies: `reviewer-claude.md`, `reviewer-deepseek.md`, `reviewer-codex.toml`, and `reviewer-grok.md` must align on role, input contract, output format, and failure handling; do not copy another side's tool instructions merely for mirrored synchronization.
- Skills: Claude, Codex, and Grok skills live under their adapter resource roots. Same-name skills must align on triggers and target behavior, while execution steps should follow each adapter's actual tool capabilities.
- Packaged resources must be self-contained: app conventions, reviewer agents, and skills must remain fully usable when no user-customized agents / skills exist.
