# Runtime project scan — 2026-09-04-project-scan

Baseline and final checked HEAD: `072dd7a284eebc2752dab7e5d5505aa2ee480b77`, `main`. The tracked worktree was clean before and after inspection. This was an ordinary independent scan, without paired review, delegation, fixes, installation, packaging, or live runtime actions.

## Result

Three MEDIUM functional findings and one LOW architecture opportunity. The findings below are current-code observations, not the deleted compatibility chains from REVIEW_267. No new obsolete compatibility or confirmed dead production module is proposed for removal. This bounded scan does not establish that the entire adapter area is defect-free.

| ID | Kind | Severity | Confidence | Result |
| --- | --- | --- | --- | --- |
| runtime-01 | Functional defect | MEDIUM | High | Server Core approval sends empty tool arguments to Claude. |
| runtime-02 | Functional defect | MEDIUM | High | Claude strict rollback waits for a stream whose input it has not closed. |
| runtime-03 | Functional defect | MEDIUM | High for the cancellation path; provider occurrence rate unmeasured | Removing a Grok submitting prompt does not cancel its RPC; the watchdog later permits another prompt on that transport. |
| runtime-04 | Architecture opportunity | LOW | High | Codex stores one queue as three positional arrays, requiring synchronized mutations in seven production modules. |

## runtime-01 — Remote approval discards the original Claude tool input

Primary location: `src/main/adapters/claude-code/sdk-bridge/permission-responder-core.ts:68`. Cross-track caller: `src/hosts/server-core/runtime-pending.ts:279` (remote track).

```ts
if (response.decision === 'allow') {
  entry.resolver({
    behavior: 'allow',
    updatedInput: (response.updatedInput ?? {}) as Record<string, unknown>,
```

Supported trigger: a Server Core Claude session in an asking permission mode requests an ordinary `Edit`, `Write`, or `Bash` action; the Remote user approves the complete displayed request. Server Core intentionally sends `{ decision: 'allow' }`, relying on the optional `PermissionResponse.updatedInput` contract. The Claude responder converts the omitted override to `{}` instead of retaining `entry.payload.toolInput`.

Consequence: the Remote mutation reports `resolved`, but the native permission response supplies empty arguments rather than the approved operation. Tools with required arguments cannot execute the action as approved. The original input remains available in the pending entry at the point it is discarded.

Production chain: Server Core `runtime-core.ts:339` `respondPending` → `respondToServerCorePending` → Claude adapter `respondPermission` → bridge/responder. `src/shared/types/permission.ts:19` explicitly makes `updatedInput` optional. The installed Claude Agent SDK 0.3.260 also declares optional `PermissionResult.updatedInput` in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2324`.

Verification: the isolated integration in `scan-repro.test.ts` uses the real Server Core pending handler and real Claude responder. Original Edit arguments were `{file_path:'/workspace/app.txt', old_string:'before', new_string:'after'}`; the result was `resolved` and the native response was `{behavior:'allow', updatedInput:{}}`. No native model or file edit ran.

Counter-evidence: the normal Desktop renderer passes `payload.toolInput` explicitly at `src/renderer/components/pending-rows/PermissionRow.tsx:204`, and the same experiment with that input preserved all arguments. Thus the demonstrated trigger is the Server Core response path, not every Desktop approval. Existing responder tests cover timeout and mode failure; Server Core projection tests use a responder mock and do not cross this boundary.

Proposed fix: have the Claude responder default to the original pending tool input, while honoring an explicit override. Add one integration regression across the Server Core handler and the responder. No product or compatibility decision is needed; coordinate ownership with the remote scan worker to avoid a duplicate finding.

## runtime-02 — Claude strict rollback never initiates stream termination

Primary location: `src/main/adapters/claude-code/sdk-bridge/session-lifecycle-core.ts:149`.

```ts
if (!(await waitForStreamDrained(internal, input.sessionId, host))) {
  internal.expectedClose = expectedCloseBefore;
  throw new Error(
    `Claude rollback close could not prove provider stream termination for ${input.sessionId}`,
  );
}
```

Supported trigger: a trusted continuation candidate is rejected, for example by a context-window limit, and handoff tries to remove the first candidate before a lower-budget retry. A healthy streaming Claude query remains open after the current result/interrupt so it can receive another user turn. The strict close calls `query.interrupt()` and waits for `streamDrained`; it calls `cleanupSession` only after that wait succeeds.

The wait depends on cleanup: `user-message-stream-core.ts:132` waits on `internal.notify` while the runtime remains registered. `pending-cancellation-core.ts:113` removes that registration and `:121` wakes the input generator. Strict rollback executes neither before waiting, nor calls the SDK's explicit query close. `expectedClose` only suppresses error presentation; the input generator does not use it as a termination condition.

Consequence: after the 1,000 ms timeout the strict close rejects and retains the target runtime. The handoff gate returns `target-rollback-failed` instead of attempting the prepared lower-budget successor; the uncommitted target cannot be cleanly removed through this path. The same strict close is used for Claude native-fork rollback.

Production chain: `session/hand-off/executor.ts` → `selectTrustedContinuationCandidate` (`trusted-continuation-gate.ts:97`) → `rollbackTrustedContinuationCandidate` (`continuation-context/fresh-session-executor.ts:33`) → `ClaudeCodeAdapter.closeSessionForRollback` (`adapter-core.ts:187`) → bridge → `closeClaudeSessionForRollbackCore`. Session deletion is after strict close and is therefore skipped on failure.

Verification: isolated reproduction uses the real input generator, lifecycle core, pending cleanup, and internal-session factory. It models the documented reusable streaming query with an interrupt acknowledgement. At 1,001 ms, strict rollback rejected, cleanup had 0 calls, and the session map still held the runtime. The same state passed ordinary close, which removed the map entry and woke/ended the generator. The installed SDK 0.3.260 implementation of `interrupt` sends an interrupt control request; its public `Query.close()` is separately documented to terminate the process at `sdk.d.ts:2912`.

Counter-evidence: strict rollback succeeds if the provider stream has already independently ended. Ordinary close deliberately performs cleanup before its bounded wait. Existing lifecycle-core tests check identity lookup/retirement and permission serialization, not this strict close/input-stream combination. No live CLI termination experiment was performed.

Proposed fix: separate “seal and terminate provider/input” from “release runtime ownership”; initiate termination before waiting, then release claims/tokens/registration only after the required proof. Use the SDK's explicit close/abort surface where appropriate, without weakening the strict rollback contract. No user-owned product decision is needed.

## runtime-03 — Removing a Grok submitting prompt leaves its native request pending

Primary location: `src/main/adapters/grok-build/turn-queue.ts:160`; related failure handling: `session-command-feedback.ts:74`.

```ts
await runtime.process?.connection.agent.notify(methods.agent.session.cancel, {
  sessionId: requireNativeSession(runtime),
});
```

Supported trigger: the Desktop user removes a pending outgoing Grok message after `session/prompt` was written but before its user echo. The queue notifies `session/cancel` and marks the submission cancelled, but does not abort `runtime.currentTurnController`. The adapter explicitly supports missing terminal responses after cancellation: its ordinary interrupt path explains and handles that state in `runtime-lifecycle-coordinator.ts:33`.

Consequence when that cancellation response is absent: the removed message keeps `runtime.running = true`, blocking the next queued prompt for the 90-second first-model-event watchdog. When the watchdog fires, `handleGrokTurnFailure` returns early for the cancelled submission, skipping transport close. The finally block clears the turn controller and drains the next prompt on the same transport while the original RPC remains unresolved. Late events from the unretired request can consequently reach the next runtime turn; this latter event-misattribution consequence was not dynamically exercised.

Production chain: Desktop `AdapterSendMessage` sets deferred user events/correlation (`src/main/ipc/adapters-outgoing.ts:69`); `AdapterDeletePendingOutgoing` (`:108`) → Grok adapter `removePendingOutgoingMessage` (`adapter-core.ts:244`) → bridge → queue cancellation. The actual prompt RPC owns `currentTurnController.signal` at `turn-queue.ts:396`.

Verification: isolated test uses the real Grok queue and translation-state factory, a fake ACP transport that acknowledges the cancel notification without a terminal prompt response, and an empty history location under this scan's temporary directory. Removal succeeded and `session/cancel` was sent. At 89,999 ms the next message was still blocked; at 90,000 ms a second `session/prompt` was issued on the same transport, the first signal was still un-aborted, and close had 0 calls. No provider process or user history was accessed.

Counter-evidence: prompt cancellation works if Grok supplies its terminal response; the existing queue test explicitly resolves that response after removal (`__tests__/turn-queue.test.ts:408`). Ordinary interrupt aborts the corresponding request and has a regression assertion for it (`__tests__/runtime-lifecycle-coordinator.test.ts:69`). Interjection cancellation already aborts its own request controller. Production incidence/latency of a missing cancel terminal response was not measured.

Proposed fix: after the matching pre-acceptance cancellation wins, cancel the matching prompt RPC and guarantee terminal-or-transport-retirement before another prompt is issued. Preserve the existing echo-versus-cancel ownership check so an accepted message is not falsely reported as removed. No product or compatibility decision is required.

## runtime-04 — Make each Codex queue element own its metadata

Primary location: `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:273`; schema: `sdk-bridge/types.ts:104`.

```ts
const input = internal.pendingMessages.shift()!;
const deferredUserEvent = internal.pendingDeferredUserEvents?.shift() ?? null;
internal.pendingHandOffMessages?.shift();
```

Current maintenance cost: one logical input is stored as three index-correlated arrays. Production enqueue must pad optional metadata arrays to the current input count (`message-controller.ts:208-233`); requeuing a submitting steer repeats that padding (`cwd-transition-controller.ts:83-98`); removal performs synchronized splices. Creation, fork creation, turn consumption, retirement, and resume-failure cleanup must preserve the same alignment separately. A repository search located seven production mutation owners: `message-controller.ts`, `cwd-transition-controller.ts`, `thread-loop.ts`, `session-retirement.ts`, `resume-path-await.ts`, `create-session/create-session-impl.ts`, and `fork-session/create-forked-session.ts`.

This is a source-demonstrable coordination cost, not a claim of currently reproduced metadata corruption. The nullable fallback and padding code are counter-evidence that current ordinary producers are deliberately accommodating partially initialized metadata. The create/fork and cwd-transition paths are production entrypoints, so the arrays cannot simply be deleted as unused.

Proposed change: use one typed pending-turn object containing input, deferred user event, and handoff snapshot, with a queue owner for append/prepend/remove/consume. Keep the public adapter contracts and provider acceptance timing unchanged. The user-owned decision is whether to schedule this internal refactor; it need not block the three bounded defect fixes. No extra runtime test was run solely for this architecture observation.

## Coverage, compatibility, and limits

Exact assigned inventory: `inventory.txt`, copied from `ref/reviews/recent-3-days/project-code-quality-scan-evidence/scopes/runtime-scope.txt`. It contains all 601 tracked files: 266 `.test` files and 335 other source/test-support files. All were inventoried; 95 primary files (85 non-`.test` files and 10 tests) were directly read, plus 11 cross-track context files. The direct-read ledger records ranges and includes excerpts; it is not a line-by-line or dynamic audit of all 601 files. Later code reads omitted comment-only/blank lines.

| Area | Inventory | Direct files read | Main traced flows |
| --- | ---: | ---: | --- |
| Claude | 248 | 28 | Create/query start, first-id timeout/adoption, input generator, recovery, permissions, close/rollback/retirement, cwd restart, hooks. |
| Codex | 186 | 34 | Create/resume/fork initialization, client/server requests, thread readiness, acceptance/cancel/watchdog, queue metadata, cleanup, recovery, hook registration. |
| Grok | 109 | 25 | Create/load/recovery, ACP transport ownership, permissions, prompt/interjection cancellation, first event/completion recovery, sandbox restart, hooks. |
| Shared and trust | 58 | 8 | Provider registry/composition, adapter contract, enqueue idempotency, trust-state safety. |

Search breadth included all adapter production files for legacy/compatibility markers, lifecycle and permission owners, all three Codex queue arrays, plus repository-wide caller/registration searches into Desktop bootstrap, Server Core composition, IPC, and handoff. Exact direct files: `direct-inspected-files.txt`; excerpt ranges: `inspected.txt`; cross-track context: `context-inspected-files.txt`; machine-readable counts: `coverage.json`.

Compatibility/dead-code classification:

- Confirmed dead: none established by this worker. No removal recommendation.
- Candidate dead: none promoted. The lead owns the full production-entrypoint graph, computed-import, package and headless-root cross-check.
- Necessary/current boundaries inspected: application/native identity, JSONL/history recovery entrypoints, Grok missing-response completion recovery, native permission decision mapping, current CLI hook routes, and Core/host injection. Provider composition has active callers in Desktop bootstrap and Server Core; these layers are not orphan facades.
- Explicit product decision: Codex does not implement generic native `AskUserQuestion`/`ExitPlanMode`; it only adapts MCP approval-shaped `requestUserInput`. Current adapter comments and controller tests make that exclusion explicit. It is not reported as a defect or dead code.
- REVIEW_267 retained string-error and binary-resolution boundaries were not proven removable. Retired Image MCP and legacy Browser fronts were not re-reported.

Gaps: no live model/provider execution, real shutdown/relaunch, real permission grant, Browser interaction, raw transcript inspection, user database access, performance load test, dependency update, packaging, or complete suite. Usage-accounting internals, resource discovery/binary resolution, complete fork rollback variants, and every injected host implementation did not receive deep inspection. No claim is made about provider process behavior after host exit; empty shutdown hooks alone were insufficient to conclude an orphan-process defect. The lead owns integrated architecture/type checking and final cross-track deduplication.

## Validation and reproducibility

All experiment/config/report writes stayed under `/tmp/agent-deck-scan/2026-09-04-project-scan/runtime/`. Existing source and Git remained unchanged. Used Node 22.22.3 selected by the existing mise environment and the repository Electron-as-node test wrapper. No SQLite or native binding change was necessary.

Commands, run from the repository root:

```sh
pnpm run test --config /tmp/agent-deck-scan/2026-09-04-project-scan/runtime/vitest.config.mjs --reporter=verbose
pnpm run test --config /tmp/agent-deck-scan/2026-09-04-project-scan/runtime/focused.config.mjs --reporter=verbose
```

Results: `repro-results.txt` — 1 temporary test file, 3 evidence cases passed; `focused-results.txt` — 9 existing test files, 41 tests passed. `existing-tests.txt` is the exact focused test list. Both temporary configs disable the cache and constrain execution to one worker; no repository config rewrite/setup write was used. An initial `pnpm test --config ...` command was rejected by pnpm before execution; `pnpm run test` correctly forwarded the arguments.

The reproduction tests assert the observed buggy outputs and include counter-examples; they are disposable evidence, not proposed permanent tests. Live provider-side consequence/occurrence rates remain bounded by the limits stated per finding. No fixes are included or authorized by this report.
