# CHANGELOG_316: Return Claude UI-created sessions before SDK first id

## Summary

Claude-side new-session creation now matches the Codex fast-return UX: the UI receives a visible temporary session immediately, while the SDK first-id wait and temp-to-real rename continue in the background. MCP/programmatic creates still wait for the canonical id.

## Changes

- Added `awaitCanonicalId` to Claude create options and facade passthroughs.
- Changed default UI-created Claude and Deepseek-Claude sessions to emit a temporary `session-start` and first user message before waiting for the SDK first id.
- Background Claude startup now finalizes metadata after temp-to-real rename without duplicating the session-start or first-user events.
- Kept `spawn_session` stable by passing `awaitCanonicalId: true` for all adapters.
- Added close-before-first-id guards so a late SDK id cannot rename or revive a user-closed temporary session.
- Kept visible startup failures attached to the visible temp session with an error message and failed `finished` event.
- Added regression coverage for fast return, canonical mode, no duplicate initial events, failure cleanup, and MCP canonical-id behavior.

## Validation

- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-failure-cleanup.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/setttimeout-fallback-symmetry.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/session-finalize.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts`
- `pnpm exec tsc --noEmit --pretty false`
- `pnpm build`

## Do Not Split Protection

- `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts` remains over 500 LOC. This change only adds a first-id mutation guard inside the existing stream loop; splitting the stream processor would widen a latency fix into a lifecycle refactor.
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts` remains over 500 LOC. This change only updates the existing create options object to request canonical ids for all adapters; splitting the MCP spawn handler is out of scope for this targeted fix.

## Related

- Plan: `ref/plans/claude-session-create-lag-20260622.md`
- Review: `ref/reviews/REVIEW_136.md`
