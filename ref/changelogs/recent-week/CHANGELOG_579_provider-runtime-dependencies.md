---
changelog_id: 579
changed_at: 2026-08-09
---

# CHANGELOG_579_provider-runtime-dependencies: Refresh packaged agent runtimes

## Summary

Agent Deck now packages the current stable Claude, Codex, and Grok runtime dependencies, including
Grok Build's `1.0.0` release.

## Changes

### Runtime dependencies

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.222` to `0.3.226`, including its supported
  platform-specific executables.
- Updated `@anthropic-ai/sdk` from `0.115.0` to `0.116.0`.
- Updated `@openai/codex` from `0.146.0` to `0.147.0`, including its supported platform-specific
  executables.
- Updated `@xai-official/grok` from `0.2.118` to `1.0.0`, including all six declared native
  platform packages.
- Regenerated `pnpm-lock.yaml` while retaining the existing package-manager and Node.js constraints.

### Packaging

- Confirmed Grok `1.0.0` retains the `bin/grok.br` native payload layout used by the bundled binary
  preflight and secure materialization path.
- Built the macOS arm64 application and DMG with the refreshed Claude, Codex, and Grok binaries.

## Validation

- `node scripts/verify-bundled-grok.mjs`
- `pnpm check:grok-remote-sandbox`
- Targeted provider packaging and binary-layout tests: 4 files and 36 tests passed.
- `pnpm typecheck`
- `pnpm test`: 860 files and 5,610 tests passed; 2 files and 3 tests skipped.
- `pnpm postinstall`
- `pnpm dist:mac`
- Packaged Worker runtime versions: Claude Code `2.1.226`, Codex CLI `0.147.0`, and Grok `1.0.0`.

## Do Not Split Protection

None. This dependency-only change does not modify production source files.

## Notes

The README already documents target-native packaging and local ad-hoc signing without pinning
provider dependency versions, so no workflow documentation change was required.
