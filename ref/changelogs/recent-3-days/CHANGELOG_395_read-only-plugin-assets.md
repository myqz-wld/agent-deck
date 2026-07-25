---
changelog_id: 395
changed_at: 2026-07-25
---

# CHANGELOG_395_read-only-plugin-assets: Align read-only native and Plugin assets

## Summary

Align Claude Code, Codex CLI, and Grok Build around one ownership model: Agent Deck discovers and
launches supported direct and Plugin Agents, but user-owned Agents and Skills remain read-only and
must be created, edited, deleted, installed, or enabled through their native CLI ecosystems.

## Changes

### Read-only Assets Library

- Remove the user Agent/Skill editor components, create/edit/delete controls, mutation IPC
  channels, preload methods, and shared write payload types.
- Keep content viewing and Finder/Explorer reveal for direct and Plugin assets, with exact path
  matching when duplicate names exist or a Plugin cache contains multiple versions.
- Display Plugin assets as `plugin:<plugin>/<asset>` with `Plugin · <plugin>` and `只读` badges;
  Plugin Agents additionally show the `spawn_session` selector `<plugin>:<agent>`.
- Preserve app-owned model, thinking, and provider overrides for immutable bundled Agents.

### Adapter ecosystem alignment

- Add shared Plugin-root discovery and align native-name validation for Claude, Codex, and Grok
  assets, including uppercase letters, dots, underscores, and names up to 128 characters.
- Resolve Claude Plugin Agents through the native Claude SDK `agent` and `plugins` fields without
  redefining the selected Plugin Agent programmatically.
- Show native Codex Plugin Skills and support Plugin `agents/*.toml` as an explicit Agent Deck
  extension mapped through the existing Codex custom-agent session configuration.
- Keep Grok Plugin Agents on ACP `_meta.agentProfile` / `_meta.pluginDirs`, add qualified selectors,
  and reject ambiguous unqualified Plugin Agent names across all adapters.

### Documentation and contracts

- Expand `spawn_session(agentName)` to accept one `<plugin>:<agent>` qualifier and document each
  adapter's native or extended Plugin boundary.
- Update the project and resources READMEs to make native CLI ownership and Assets Library
  read-only behavior explicit.

## Validation

- `pnpm typecheck`
- Targeted Assets Library, Plugin discovery, and spawn routing tests passed.
- `pnpm test:node` (314 files passed, 52 skipped; 2,649 tests passed, 435 skipped)
- `pnpm test` (365 files passed, 1 skipped; 3,083 tests passed, 1 skipped)
- `pnpm build`
- `git diff --check`
- `bash scripts/file-level-review-expiry.sh`
- Prompt-asset inventory, backup hashes, local Markdown links, paired runtime prompts, and JSON
  manifests validated.

## Do Not Split Protection

- All changed production source files remain at or below the 500-line guardrail.

## Notes

- Codex Plugins natively contribute Skills; Plugin `agents/*.toml` support is an Agent Deck
  extension rather than a native Codex Plugin Agent component.
