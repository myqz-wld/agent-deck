# resources/

Source directory for app runtime resources. `package.json` copies the adapter roots through
`build.extraResources`, so Desktop main and the Server Core node asset catalog load the same
packaged conventions, Agents, and Skills. Only the runtime window icon is stored inside `app.asar`.

## Packaging Paths

| Source directory | Packaged directory | Purpose |
|---|---|---|
| `resources/bin` | `.app/Contents/Resources/bin` | CLI wrapper and helper scripts |
| `resources/claude-config` | `.app/Contents/Resources/claude-config` | Claude Code app conventions, Gateway-backed reviewers, and plugin resources |
| `resources/codex-config` | `.app/Contents/Resources/codex-config` | Codex app conventions, custom-agent TOML, and skill resources |
| `resources/grok-config` | `.app/Contents/Resources/grok-config` | Grok Build ACP baseline, plugin agents, and skills |
| `resources/sounds` | `.app/Contents/Resources/sounds` | App notification sounds |

Dev (`pnpm dev`) reads `<repo>/resources/*` directly; production reads the
`.app/Contents/Resources/*` copies. `icon.png` is also included at
`app.asar/resources/icon.png`; `icon.ico` is a Windows builder input only.

## Immutable assets and runtime overrides

Packaged app conventions, Agents, and Skills are immutable. The Assets Library, Remote asset
catalog, and Remote Agent selection use only bundled assets. Agent Deck may attach an app-owned
runtime delta without editing this directory:

- Claude, Codex, and Grok bundled Agents may override model and thinking.
- Claude and Codex bundled Agents may additionally select their adapter's Gateway profile.
- Reset removes the whole app-owned delta and exposes the packaged Agent defaults again.
- Bundled Skills have no runtime override.

Native user and Plugin assets remain provider-owned and available to native loading and
Desktop-local spawn resolution; Agent Deck does not list or manage them.

Provider endpoints, credentials, and aliases stay in native configuration. The resource layer
stores only adapter-native Gateway ids and does not write user-level provider configuration.

## claude-config/

Gateway-backed Claude sessions reuse this root; their `gateway` id resolves to
`~/.claude/gateways/<gateway>.json` and is passed through `options.settings`.

- `CLAUDE.md`: Appended to the end of the Claude Code preset system prompt through SDK `systemPrompt.append`. User / project / local `CLAUDE.md` files are loaded separately by Claude Code as project context. The user copy saved by the settings panel is written to `<userData>/agent-deck-claude.md`; when present, it overrides the bundled file.
- `agent-deck-plugin/`: Contains `agents/reviewer-claude.md` and `skills/*/SKILL.md`. Runtime mirrors it to `<userData>/agent-deck-plugin/`, replaces resource placeholders, and prunes `agents/` or `skills/` according to their injection switches before SDK scanning.
- `spawn_session(agentName=...)` resolves bundled Agents, project `.claude/agents`, user `${CLAUDE_CONFIG_DIR:-~/.claude}/agents`, and native Claude Plugin Agents. Plugin selectors use `<plugin>:<agent>` and the selected Plugin root is passed to the Claude SDK through `plugins` for that session.

## codex-config/

Codex conventions, Agents, and Skills use separate app-server injection paths.

- `CODEX_AGENTS.md`: After resource placeholder replacement, injected through app-server `developerInstructions`, independently of Codex's native `AGENTS.md` chain. The settings-panel copy at `<userData>/agent-deck-codex-agents.md` overrides the bundled file.
- `agent-deck-plugin/`: Contains `agents/reviewer-codex.toml` and `skills/*/SKILL.md`. The Agent loader scans the TOML for bundled routing; Skills are mirrored under app userData and injected through `skills/extraRoots/set`. Their respective switches skip only the bundled roots.
- Native Codex Plugins contribute Skills; Agent Deck also recognizes Plugin `agents/*.toml` as an extension and maps supported fields into the existing session configuration. `spawn_session(agentName=...)` resolves bundled, project `.codex/agents`, user `${CODEX_HOME:-~/.codex}/agents`, and Plugin TOML Agents; Plugin selectors use `<plugin>:<agent>`.
- The public `provider` field contains a Gateway id discovered from `${CODEX_HOME:-~/.codex}/gateways/*.toml`. The filename stem is its id and display name; enumeration does not read file contents.
- Each Codex Gateway file is a complete ordinary native Codex TOML config. `model_provider`,
  `model_providers`, `model`, and other keys are optional. Agent Deck applies the full config to new,
  resumed, forked, and internal threads; top-level `model_provider`, when present, is also sent as
  app-server `modelProvider`. Remote provider homes receive the same validated file. An empty
  Gateway selection delegates to `${CODEX_HOME:-~/.codex}/config.toml`; otherwise the same-named
  Gateway TOML is used. Agent Deck-owned MCP and runtime safety boundaries remain authoritative.
- Agent Deck reads native Codex configuration and Gateway profiles but does not write
  `${CODEX_HOME:-~/.codex}/config.toml`, `${CODEX_HOME:-~/.codex}/gateways/`,
  `~/.codex/AGENTS.md`, or `~/.codex/skills/agent-deck/`.

## grok-config/

Grok Build uses this root through the ACP v1 `session/new` / `session/load` metadata surface.

- `GROK_AGENTS.md`: Passed through ACP `_meta.rules` when the Grok app-conventions switch is enabled. Grok Build consumes the rules while constructing a new native session; loading an existing native session retains its persisted system prompt. Asset Library edits are stored separately at `<userData>/agent-deck-grok-agents.md`; that app-owned copy wins until **Restore default** deletes it. `_meta.rules` remains independent of `_meta.agentProfile`, so the convention also applies when a bundled Grok Agent is selected.
- `agent-deck-plugin/`: Contains `reviewer-grok` and the review Skills. Because Grok accepts a whole Plugin directory, the independent Agent and Skill switches select subdirectories for an app-owned mirror under `<userData>/grok-plugin-profiles/`; ACP receives that mirror through `_meta.pluginDirs`.
- `spawn_session(agentName=...)` resolves Grok's bundled, project (`.grok/agents`), user (`~/.grok/agents`), and native Plugin Agents. Plugin selectors use `<plugin>:<agent>`; the selected native profile and Plugin root are passed through ACP `_meta.agentProfile` / `_meta.pluginDirs`.
- The mirror and editable application-convention copy contain only Agent Deck-owned resources. Agent Deck does not write `~/.grok/config.toml`, `~/.grok/AGENTS.md`, or user plugins.
- The Grok binary is not part of `extraResources`; Settings may point to an installed binary, otherwise the adapter resolves `grok` from the user shell `PATH`.

## Paired Boundaries

- App conventions must align protocol semantics across `resources/claude-config/CLAUDE.md`,
  `resources/codex-config/CODEX_AGENTS.md`, and `resources/grok-config/GROK_AGENTS.md`, while keeping
  adapter-specific execution details. Shared rules must work with Desktop-local and Server Core;
  the live schema remains authoritative for arguments and optional fields.
- Reviewer bodies: `reviewer-claude.md`, `reviewer-codex.toml`, and `reviewer-grok.md` must align on role, input contract, output format, and failure handling; do not copy another side's tool instructions merely for mirrored synchronization.
- Skills: Claude, Codex, and Grok skills live under their adapter resource roots. Same-name skills must align on triggers and target behavior, while execution steps should follow each adapter's actual tool capabilities.
- Packaged resources must be self-contained: app conventions, reviewer agents, and skills must remain fully usable when no user-customized agents / skills exist.
