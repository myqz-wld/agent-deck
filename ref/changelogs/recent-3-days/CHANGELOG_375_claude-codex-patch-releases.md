---
changelog_id: 375
changed_at: 2026-07-15
---

# CHANGELOG_375_claude-codex-patch-releases: Advance agent runtime patches

## Summary

Agent Deck now packages the latest stable patch releases of the Claude Agent SDK and Codex CLI.

## Changes

### Runtime dependencies

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.210` to `0.3.211`, including all supported
  platform-specific executable packages.
- Updated `@openai/codex` from `0.144.4` to `0.144.5`, including all supported platform-specific
  packages.
- Confirmed `@anthropic-ai/sdk` remains current at `0.111.0` and both updated packages retain
  compatibility with the repository's Node.js and peer dependency constraints.
- Regenerated `pnpm-lock.yaml` only for the affected Claude and Codex packages.

## Validation

- `pnpm typecheck` passed.
- Full suite: 315 files and 2,873 tests passed; one credentialed live smoke remained skipped.
- `pnpm build` passed.
- Native `better-sqlite3` dependencies were restored through the repository postinstall flow after
  the Electron test suite.

## Do Not Split Protection

None. This dependency-only change does not modify production source files.

## Notes

The README packaging contract already describes the Claude and Codex platform-package requirements
without pinning internal dependency versions, so no README change was needed.
