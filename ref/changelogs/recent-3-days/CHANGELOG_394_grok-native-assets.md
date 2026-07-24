---
changelog_id: 394
changed_at: 2026-07-24
---

# CHANGELOG_394_grok-native-assets: Support Grok native user assets

## Summary

Align Grok asset handling with the Claude Code and Codex CLI views: named native Agents can be
selected through `spawn_session(agentName=...)`, while direct user assets are visible and editable
in the Assets Library.

## Changes

### Native Agent resolution

- Resolve Grok named Agents from bundled Agent Deck assets, project `.grok` assets, user
  `~/.grok` assets, and discoverable native plugin directories.
- Pass the selected native profile through ACP `_meta.agentProfile`, including the selected plugin
  directory through `_meta.pluginDirs` when the Agent belongs to a plugin.
- Keep Agent Deck's bundled plugin injection independent from native user/plugin Agents, so a
  selected user-owned Agent is not shadowed by the app-owned Agent Deck Agent directory.

### Assets Library and editing

- Add Grok user Agents and Skills to the Assets Library, including native plugin components found
  through Grok's configured plugin paths and compatible user plugin locations.
- Allow direct `~/.grok/{agents,skills}` assets to be created, edited, deleted, viewed, and revealed
  in place; plugin-owned components remain visible for inspection but are read-only.
- Support Grok-native Agent names, models, and reasoning effort values without changing Claude or
  Codex asset validation rules.

### Documentation and contracts

- Extend the shared asset, IPC, preload, spawn option, and ACP session metadata contracts for the
  Grok adapter.
- Document Grok native asset discovery and the plugin ownership boundary in the project README
  and resources README.

## Validation

- `pnpm typecheck`
- Targeted Grok tests: 12 passed
- `pnpm test:node` (308 files passed, 52 skipped; 2,624 tests passed, 435 skipped)
- `pnpm test` (359 files passed, 1 skipped; 3,058 tests passed, 1 skipped)
- `pnpm build`
- `git diff --check`

## Do Not Split Protection

- Keep `src/main/adapters/grok-build/custom-assets.ts`, `src/main/user-assets.ts`, and
  `src/renderer/components/assets/AssetEditor.tsx` below the repository's 500-line production
  source guardrail.
