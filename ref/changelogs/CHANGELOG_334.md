# CHANGELOG_334: send_message resolves target session aliases

## Summary

`send_message` now resolves target session ids through both `sessions.id` and `cli_session_id` before authorization and enqueue. This keeps MCP replies working when a worker holds a valid SDK/thread alias for an active Agent Deck session.

## Changes

- Added target resolution in the `send_message` handler: direct `sessions.id` lookup still wins, with `cli_session_id` as a fallback.
- Canonicalized the target id before shared-team checks, self-send checks, teamless reply pair validation, enqueue, and the success payload.
- Added regression coverage for a benchmark worker sending to a Codex lead through a `cliSessionId` alias while sharing an active team.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` (87 tests)
- `pnpm typecheck`

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
