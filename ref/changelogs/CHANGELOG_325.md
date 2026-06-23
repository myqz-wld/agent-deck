# CHANGELOG_325: Upgrade Claude Agent SDK to 0.3.187

## Summary

Agent Deck now depends on `@anthropic-ai/claude-agent-sdk` `0.3.187`.

## Changes

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.186` to `0.3.187`.
- Refreshed the pnpm lockfile entries for the SDK package and bundled native platform packages.
- Confirmed `@anthropic-ai/sdk` remains current at `0.105.0` and `@openai/codex` remains current at `0.142.0`.

## Validation

- `pnpm typecheck`
- `pnpm build`

## Notes

- The upstream patch release adds `sandbox.credentials` SDK settings types.
