---
changelog_id: 391
changed_at: 2026-07-24
---

# CHANGELOG_391_claude-codex-grok-dependencies: Refresh adapter runtimes

## Summary

Agent Deck now packages the latest compatible stable runtime dependencies for Claude, Codex, and
Grok Build.

## Changes

### Runtime dependencies

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.217` to `0.3.218`, including its bundled
  platform-specific executables.
- Updated `@anthropic-ai/sdk` from `0.112.5` to `0.114.0`.
- Updated `@agentclientprotocol/sdk` from `1.2.1` to `1.3.0` for the Grok Build ACP bridge.
- Confirmed `@openai/codex` remains at the latest stable `0.145.0`; no Codex lockfile change was
  required.
- Regenerated `pnpm-lock.yaml` and retained the existing Node.js and peer dependency constraints.

## Validation

- `pnpm install --ignore-scripts`
- `pnpm typecheck`

## Do Not Split Protection

None. This dependency-only change does not modify adapter production source files.
