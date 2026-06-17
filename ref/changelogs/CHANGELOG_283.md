# CHANGELOG_283: Foundation prompt asset wording cleanup

## Summary

Tightened repository foundation prompt assets without changing Agent Deck runtime protocol behavior. The changes remove stale entry-point wording, keep runtime-manager guidance project-owned, and align convention support files with the current foundation template.

## Changes

### Root Entry Assets

- Simplified `AGENTS.md` so Codex-specific reading rules live under entry differences and the shared workflow remains owned by `CLAUDE.md`.
- Removed the stale `nvm` recommendation from `CLAUDE.md`; the repository keeps only its Node.js runtime requirement and package manager.

### Bundled Metadata

- Tightened the Claude plugin metadata description to describe the bundled reviewer agents plus review and self-check skills directly.

### Foundation Records

- Aligned `ref/conventions/INDEX.md` and `ref/conventions/tally.md` wording with the current foundation templates.
- Fixed the convention tally promotion workflow to use the repository's configured review process and the `ref/conventions/<X>-<topic>.md` target path.
- Kept existing convention candidates intact; only the file-level process wording changed.

## Notes

Paired Claude/Codex runtime prompt assets, reviewer agents, review/self-check skills, and MCP tool descriptions were inspected and left unchanged because their current wording preserves self-contained Agent Deck protocol behavior and adapter-specific mechanics.
