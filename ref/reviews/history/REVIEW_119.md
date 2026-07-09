# REVIEW_119 — standalone `spawn_session` children could not reply

- Trigger: user reported that non-team spawned sessions eventually render as parent/child in the live list, but the child prompt does not include the parent session id or reply instructions, so the child cannot use `send_message` to communicate.
- Scope: `spawn_session` prompt injection, placeholder message creation, first-reply anchor semantics, immediate `spawnedBy` UI refresh, and Claude/Codex bundled protocol wording.
- Method: direct code tracing plus focused regression tests. The behavior reuses the reviewed teamless DM path from CHANGELOG_194 / REVIEW_100; no broader adversarial review was run.
- Related changelog: [CHANGELOG_279.md](../../changelogs/history/CHANGELOG_279.md).

## Findings

1. **MEDIUM fixed — standalone spawn did not get a reply anchor**
   - Evidence: `spawn.ts` used `willInjectWirePrefix = !!teamIdEarly && callerExists`, so only `spawn_session({ teamName })` received `[msg <id>][sid <lead>]` and the lead context block.
   - Impact: standalone children received only the raw task prompt. Even though teamless DM supports no-team communication, the child did not know the lead session id or `replyToMessageId`.
   - Fix: normal caller-owned spawns now generate a placeholder id, inject the wire prefix/context block, and insert a delivered placeholder. Standalone placeholders use `teamId=null`.

2. **LOW fixed — spawn tree rendering depended on later events**
   - Evidence: `sessionRepo.setSpawnLink()` updates `sessions.spawned_by` but does not emit `session-upserted`. Some spawns only became visibly nested after later SDK events caused a fresh session record to reach the renderer.
   - Fix: after a successful `setSpawnLink`, `spawnSessionHandler` re-reads the child record and emits `session-upserted`.

3. **LOW fixed — prompt assets implied the anchor was team-only**
   - Evidence: bundled Claude/Codex protocol text said passing `teamName` creates a team and returns `spawnPromptMessageId`, which could be read as team-only.
   - Fix: both bundled baselines now state that `spawn_session` returns `spawnPromptMessageId`; `teamName` only controls shared-team creation. The first-reply section says standalone replies omit `teamId`.

## Regression Tests

- `lead-context-block.test.ts`
  - `teamId=null` renders a teamless DM example without a `teamId` argument.
- `tools.test.ts`
  - standalone spawn returns `spawnPromptMessageId`, injects `[msg][sid]`, writes `teamId=null` placeholder, and marks it delivered.
  - standalone spawn emits `session-upserted` with `spawnedBy` and `spawnDepth`.
  - native `agentName` config remains adapter-native and is not prepended into the user prompt.

## Validation

- `pnpm test src/main/agent-deck-mcp/__tests__/lead-context-block.test.ts src/main/agent-deck-mcp/__tests__/tools.test.ts` ✅
- `pnpm typecheck` ✅
