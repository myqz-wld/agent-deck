---
changelog_id: 369
changed_at: 2026-07-15
---

# CHANGELOG_369_claude-codex-dependencies: Refresh agent runtimes

## Summary

Agent Deck now packages the latest compatible Claude Agent SDK and Codex CLI releases available at
the time of this update.

## Changes

### Runtime dependencies

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.207` to `0.3.210`, including its bundled
  platform-specific executables.
- Updated `@openai/codex` from `0.144.1` to `0.144.4`, including all platform-specific packages.
- Confirmed `@anthropic-ai/sdk` remains current at `0.111.0`.
- Regenerated `pnpm-lock.yaml` only for the affected Claude and Codex packages.

## Validation

- `pnpm typecheck` passed.
- Full suite: 310 files / 2,837 tests passed; one credentialed live smoke remained skipped.
- `pnpm build` passed.

## Do Not Split Protection

None. This dependency-only change does not modify production source files.
