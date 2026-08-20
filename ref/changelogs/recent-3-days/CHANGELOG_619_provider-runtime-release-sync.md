---
changelog_id: 619
changed_at: 2026-08-19
---

# CHANGELOG_619_provider-runtime-release-sync: Sync provider runtime releases

## Summary

Agent Deck now resolves the current stable Claude Code, Grok Build, and Codex CLI releases from
its embedded dependency graph, while the matching machine-local CLIs have been updated to the same
runtime versions.

## Changes

### Embedded provider runtimes

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.233` to `0.3.237`, including the eight
  supported platform packages and their vendored Claude Code executables.
- Updated `@anthropic-ai/sdk` from `0.117.1` to `0.120.0`.
- Updated `@openai/codex` from `0.147.0` to `0.148.0`, including all six native platform aliases.
- Updated `@xai-official/grok` from `1.0.4` to `1.0.5`, including all six native platform
  packages.
- Confirmed `@agentclientprotocol/sdk` remains current at `1.3.0` and regenerated
  `pnpm-lock.yaml` without unrelated dependency upgrades.

### Machine-local CLIs

- Updated the native Claude Code installation from `2.1.233` to `2.1.237`.
- Updated the managed stable-channel Grok Build installation from `1.0.4` to `1.0.5`.
- Updated both the PATH-preferred `/opt/homebrew` npm installation and the mise-managed Node
  `22.22.3` installation of Codex CLI from `0.147.0` to `0.148.0`.

### Application package status

- Verified the dependency-installed macOS arm64 executables report Claude Code `2.1.237`, Codex
  CLI `0.148.0`, and Grok Build `1.0.5`.
- Did not generate a DMG or `.app`, stop the running application, or replace the installed
  `/Applications/Agent Deck.app`, as requested. The refreshed runtimes will be embedded by the
  next packaging run.

## Validation

- Registry dist-tag and compatibility metadata checks for all provider packages.
- `pnpm install --frozen-lockfile`
- Claude Agent SDK `query` export smoke check.
- Direct embedded macOS arm64 runtime version checks for Claude, Codex, and Grok.
- `pnpm typecheck`
- `pnpm test`: 994 files and 6,235 tests passed; 2 files and 3 tests skipped.
- `pnpm postinstall` restored the Electron `better-sqlite3` binding after tests.
- `pnpm build`
- `pnpm verify:bundled-runtimes`
- Direct local CLI version checks for Claude, Grok, and both Codex installations.

## Do Not Split Protection

None. This dependency-only change does not modify production source files.

## Notes

The README already documents bundled runtime selection and packaging without pinning provider
versions, so no workflow documentation update was needed.
