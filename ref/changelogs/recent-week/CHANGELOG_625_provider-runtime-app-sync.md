---
changelog_id: 625
changed_at: 2026-08-23
---

# CHANGELOG_625_provider-runtime-app-sync: Refresh provider runtimes and app package

## Summary

Agent Deck now packages the current stable Claude and Codex runtime releases, uses ACP `1.4.0`
for Grok integration, and has been rebuilt and installed locally with the refreshed macOS Worker
binaries. Grok remains on its current official stable release, `1.0.5`.

## Changes

### Embedded provider dependencies

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.237` to `0.3.241`, including all eight
  supported platform packages and their vendored Claude Code executables.
- Updated `@openai/codex` from `0.148.0` to `0.149.0`, including all six native platform aliases.
- Updated `@agentclientprotocol/sdk` from `1.3.0` to `1.4.0` for the Grok ACP bridge.
- Confirmed `@anthropic-ai/sdk` remains current at `0.120.0` and `@xai-official/grok` remains on
  the official stable channel at `1.0.5`; newer published Grok versions are not tagged stable.
- Regenerated `pnpm-lock.yaml` without unrelated dependency upgrades.

### ACP 1.4 compatibility

- Removed the retired ACP `env_var` authentication branch and prevent terminal authentication
  methods from being sent through `agent/authenticate`.
- Recognize the new ACP compaction update variants exhaustively while emitting no partial
  lifecycle because Agent Deck does not advertise compaction support.
- Added focused coverage for terminal authentication and the ACP 1.4 compaction variants.

### Validation repair

- Updated the bundled Browser contract test to assert the current concise README wording instead
  of sentences removed by the earlier README streamlining change.

### Local application package

- Rebuilt and safely installed the macOS arm64 app under `/Applications/Agent Deck.app`.
- Verified installed Worker runtimes report Claude Code `2.1.241`, Codex CLI `0.149.0`, and Grok
  `1.0.5`.
- Reused the existing `/usr/local/bin/agent-deck` wrapper link and retained the generated DMG and
  block map under `build/dist`.

## Validation

- Registry dist-tag, engine, peer, optional-platform, and Grok stable-channel checks.
- `pnpm install --frozen-lockfile --ignore-scripts`
- Claude Agent SDK and ACP import smoke checks.
- Focused provider coverage: 3 files and 44 tests passed.
- `pnpm typecheck`
- `pnpm test`: 1,002 files and 6,267 tests passed; 2 files and 3 tests skipped.
- `pnpm postinstall`
- `pnpm verify:bundled-runtimes`
- macOS Worker sandbox build, signing, and packaged-boundary checks.
- `pnpm install:local:mac`
- Installed wrapper freshness and deep macOS signature validation.
- Direct installed Worker binary version checks for Claude, Codex, and Grok.

## Do Not Split Protection

None. Both changed production files remain below 500 lines; the remaining changes are dependencies,
focused tests, and this record.

## Notes

The README already documents bundled runtime selection and local macOS installation without
pinning provider versions, so no workflow documentation update was required.
