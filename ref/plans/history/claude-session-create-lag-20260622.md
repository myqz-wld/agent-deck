---
plan_id: claude-session-create-lag-20260622
status: completed
created_at: 2026-06-22
base_commit: 4fb6987
worktree_path: /Users/wanglidong/Repository/agent-deck
---

# Claude Session Create Lag Investigation

## Goal

Identify and remove avoidable UI latency when creating a new Claude-side in-app session, using application logs as timing evidence and keeping MCP/programmatic spawn handles stable.

## Non-Goals

- Do not change resume, restart, or jsonl fallback behavior.
- Do not weaken SDK failure visibility.
- Do not return temporary ids from `spawn_session` or `hand_off_session`, because follow-up MCP calls need durable canonical session handles.

## Invariants

- A new UI-created Claude session still emits exactly one visible session-start event and one first user message.
- After the SDK first id arrives, the existing temp-to-real rename path still owns the canonical DB id transition.
- Closing the temporary session before the first SDK id must not let a late first-id frame revive or rename the closed session.
- MCP/programmatic creates must wait for the canonical id.

## Evidence

Application log: `~/Library/Logs/Agent Deck/main-2026-06-22.log`.

For eight non-provider-probe Claude creates, `sessionManager.expectSdkSession` to hook reclaim was consistently small: average about 267 ms, p50 259 ms, p90 277 ms, max 321 ms.

The user-visible creation delay came later, because the renderer waited for the IPC call to return and the Claude adapter did not return until the SDK first session id was known:

| Time | expect -> hook | expect -> DB session |
|---|---:|---:|
| 2026-06-22 12:30:23 | 246 ms | 1445 ms |
| 2026-06-22 16:03:45 | 259 ms | 642 ms |
| 2026-06-22 21:21:20 | 253 ms | 2598 ms |
| 2026-06-22 22:29:31 | 267 ms | 3284 ms |
| 2026-06-22 22:31:17 | 321 ms | 3106 ms |
| 2026-06-22 22:33:29 | 261 ms | 3288 ms |
| 2026-06-22 22:35:33 | 254 ms | 3286 ms |
| 2026-06-22 22:48:04 | 277 ms | 3315 ms |

Code tracing matched the timing:

- `NewSessionDialog` awaits `window.api.createAdapterSession`, then closes.
- Main IPC awaits `adapter.createSession`.
- Claude `createSessionImpl` awaited `runCreateSessionSdkQuery`, which awaited `waitForRealSessionId`.
- Codex had already been optimized in `CHANGELOG_310`: it returns a temporary visible session immediately and renames it after the real thread id arrives.

## Implementation

- Added `awaitCanonicalId` to Claude create options and passthroughs.
- Default UI-created Claude/Deepseek-Claude sessions now:
  - claim and emit a temporary visible app session immediately;
  - return that temporary id to the renderer;
  - start the SDK query in the background;
  - use the existing stream processor rename path when the first SDK id arrives;
  - finalize metadata after rename without emitting duplicate session-start or duplicate first-user events.
- MCP `spawn_session` now always passes `awaitCanonicalId: true`, preserving the existing stable-id contract for Codex, Claude, and Deepseek-Claude.
- Added close-before-real-id guards so a closed temporary session cannot be mutated by a late first-id frame.
- For visible fast-return sessions, SDK startup failures now append an error message plus a failed finished event to the already-visible temp session instead of deleting it as an invisible orphan cleanup path.

## Validation

- `pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-failure-cleanup.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/setttimeout-fallback-symmetry.test.ts src/main/adapters/claude-code/sdk-bridge/__tests__/session-finalize.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts`
- `pnpm exec tsc --noEmit --pretty false`
- `pnpm build`

## Related Records

- `ref/changelogs/CHANGELOG_316.md`
- `ref/reviews/REVIEW_136.md`
- `ref/plans/codex-create-session-latency-20260619.md`
