---
changelog_id: 614
changed_at: 2026-08-16
---

# CHANGELOG_614_provider-runtime-app-refresh: Refresh agent runtimes and apps

## Summary

Agent Deck now packages the current stable Claude and Grok runtime releases, keeps Codex on its
current stable release, and has been rebuilt and reinstalled locally with the refreshed Worker
binaries.

## Changes

### Runtime dependencies

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.226` to `0.3.233`, including all supported
  platform-specific executables.
- Updated `@anthropic-ai/sdk` from `0.116.0` to `0.117.1`.
- Updated `@xai-official/grok` from `1.0.0` to `1.0.4`, including all six declared native platform
  packages.
- Confirmed `@openai/codex` remains at the latest stable `0.147.0` and
  `@agentclientprotocol/sdk` remains at the latest stable `1.3.0`.
- Regenerated `pnpm-lock.yaml` while retaining the existing Node.js and package-manager
  constraints.

### Local applications

- Updated the native Claude Code installation from `2.1.220` to `2.1.233`.
- Updated the Grok Build managed installation from `0.2.114` to `1.0.4`; the existing
  `~/.local/bin/grok` command now resolves to the managed `~/.grok/bin/grok`, while the old binary
  remains recoverable at `~/.local/share/grok/legacy/grok-0.2.114`.
- Updated the PATH-preferred Homebrew-prefix Codex CLI from `0.140.0` to `0.147.0` and confirmed
  the mise-managed installation is also at `0.147.0`.
- Rebuilt and safely installed the macOS arm64 Agent Deck app with Worker runtimes Claude Code
  `2.1.233`, Codex CLI `0.147.0`, and Grok Build `1.0.4`.

## Validation

- Registry latest/stable metadata and `pnpm outdated` checks.
- `pnpm install --frozen-lockfile`
- Claude Agent SDK import smoke (`query` export is a function).
- `pnpm typecheck`
- `pnpm test`: 967 files and 6,124 tests passed; 2 files and 3 tests skipped.
- `pnpm postinstall`
- `pnpm build`
- `pnpm verify:bundled-runtimes`
- `pnpm install:local:mac`
- Direct installed Worker binary version checks for Claude, Codex, and Grok.
- Installed wrapper freshness and macOS signature validation.

## Do Not Split Protection

None. This dependency-only change does not modify production source files.

## Notes

The README already documents bundled runtime selection, platform-specific packaging, and the local
macOS installation flow without pinning provider versions, so no workflow documentation update was
needed.
