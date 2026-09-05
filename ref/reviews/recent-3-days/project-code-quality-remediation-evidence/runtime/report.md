# Runtime implementation evidence

Captured at worker handoff and accepted by the lead. Subsequent global validation and fixture-only corrections are recorded in REVIEW_269. The pending lead actions in the original handoff below are historical.

## Worker results

Worker status: **ready-for-review**. Implementation complete; lead acceptance and integrated validation remain pending.

### Implementation and API decisions

- runtime-01: Claude approval now falls back to the exact pending `toolInput` when `updatedInput` is absent. Explicit replacements, including `{}`, still win; deny and permission-mode behavior are retained. A permanent regression calls the real Server Core pending handler and the real Claude responder without invoking a provider.
- runtime-02: strict rollback synchronously seals provider input and wakes an idle generator, then calls installed Claude SDK `Query.close()` before waiting for `streamDrained`. It does not await `interrupt()` as a termination mechanism. Runtime registration/claims are retained while termination is unproven; timeout keeps the input sealed and preserves the prior failure-presentation fence. Cleanup follows proven output-loop termination. The input generator also checks the seal after asynchronous attachment materialization, and message ingress rejects a sealed runtime. Ordinary close and reusable interrupt behavior remain unchanged.
- runtime-03: winning pre-echo Grok deletion cancels the controller belonging to that exact prompt, releases its local response wait, and fences input/events until the existing transport recovery path has stopped the old transport and loaded its replacement. The local deletion wait is separate from the RPC signal so an earlier ordinary interrupt cannot strand it. Echo winning while the cancel notification is being written still returns no deletion; interjection and ordinary interrupt semantics are preserved. Recovery error copy now describes ACP recovery generically because cancellation can also use that path.
- runtime-04: `CodexPendingTurnQueue` owns one typed entry containing provider input, nullable deferred user event, and nullable handoff snapshot. Append, prepend, removal, consumption and clear now mutate one representation. All seven production mutation owners (message controller, cwd transition, turn loop, retirement, resume cleanup, create, fork) and the session-command read sites were migrated. No correlated array names remain in the Codex adapter. Provider input encoding, acceptance timing, private continuation text, upload ownership, idempotency and handoff snapshots remain intact.
- Installed API evidence: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` documents `Query.close()` as terminating the underlying query/process, independently from turn-level `interrupt()`. `node_modules/@agentclientprotocol/sdk/dist/jsonrpc.js` `prepareRequest` shows ACP 1.4 cancellation sends `$/cancel_request` without settling the pending response, which requires the local deletion wait and transport retirement used here. No live provider was used for this evidence.
- File-size work: extracted the Grok pending-cancellation helper, and split Codex create-session, consume/restart, fork and wire-prefix test fixtures/groups. All 45 changed/new adapter files are at most 500 lines (largest: `thread-loop.ts`, 498). No shared-source or prompt-asset expansion was needed.

### Permanent regression coverage

- Claude: remote approval with original Edit arguments; explicit nonempty/empty overrides; deny/mode retention; rollback input EOF versus output-drain ownership; close failure/timeout and retry; in-flight attachment cancellation; ordinary interrupt/reuse and ordinary close ordering; missing runtime evidence.
- Grok: missing terminal response and prompt cancellation signal; no second prompt before transport stop completes; queue progress after replacement; no replay from a late terminal; echo/cancel winner; failed cancel preserves submission; pre-RPC removal avoids transport retirement; retirement failure fences later messages; deletion after an already-aborted RPC signal.
- Codex: combined cwd prepend + requeued steer + queued deletion + mixed ordinary/deferred/image consumption, retained/deep-copied handoff snapshots and attachment metadata, resume-failure queue cleanup, and child-owned versus source-owned attachment cleanup. Existing create/fork/resume/retirement/control-command/cancellation tests were migrated and retained.

### Validation

- Final focused run: `python3 ref/reviews/recent-3-days/project-code-quality-remediation-evidence/runtime/run-focused.py`, which executes the exact `pnpm run test ... --maxWorkers=1 --minWorkers=1` command saved in [focused-command.txt](focused-command.txt), using the existing Electron-compatible runner. **46 test files / 243 tests passed**, 16.43 seconds. [Output](focused-tests.txt).
- Scoped compiler check: `node ref/reviews/recent-3-days/project-code-quality-remediation-evidence/runtime/adapter-check.cjs`; TypeScript compiler API checks syntactic and semantic diagnostics only for the 45 changed/new adapter files under existing node compiler settings, without emit or config/index writes. **0 diagnostics**. [Output](typecheck.txt). The lead still owns project-wide `pnpm typecheck`.
- `git diff --check -- src/main/adapters`: **passed**. Codex old-array search: **no matches**. [File manifest](source-manifest.json) captures the ready-for-review contents and line counts.
- Earlier targeted runs passed Claude 17 tests, Grok 39 tests and Codex 139 tests. Intermediate new-test/fixture runs found an unsupported Vitest matcher, test-fixture re-export issues and one mock return-type mismatch; all were corrected before the final passing focused run and scoped compiler check.
- Existing `better-sqlite3` binding SHA-256 before/after final tests was unchanged: `463d208825f4d2660f4ec14181563c4b2ddbfeb779584c9b3251f0d7aafb2c67`. [Fingerprint evidence](binding-fingerprint.json). No native rebuild or dependency changes.

### Exact changed adapter paths

- `src/main/adapters/claude-code/sdk-bridge/permission-responder-core.test.ts`
- `src/main/adapters/claude-code/sdk-bridge/permission-responder-core.ts`
- `src/main/adapters/claude-code/sdk-bridge/send-validation.ts`
- `src/main/adapters/claude-code/sdk-bridge/session-lifecycle-core.test.ts`
- `src/main/adapters/claude-code/sdk-bridge/session-lifecycle-core.ts`
- `src/main/adapters/claude-code/sdk-bridge/session-rollback-core.test.ts`
- `src/main/adapters/claude-code/sdk-bridge/types.ts`
- `src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts`
- `src/main/adapters/codex-cli/__tests__/consume-fork-fixture.ts`
- `src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts`
- `src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts`
- `src/main/adapters/codex-cli/__tests__/sdk-bridge.restart.test.ts`
- `src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts`
- `src/main/adapters/codex-cli/__tests__/wire-prefix-fixture.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-early-rollback.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-fixture.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-new-latency.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/cwd-transition-controller.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/message-controller-handoff.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/pending-turn-queue.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/session-lifecycle-coordinator.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/session-retirement.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/__tests__/trusted-continuation-new.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/constants.ts`
- `src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts`
- `src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-validate.ts`
- `src/main/adapters/codex-cli/sdk-bridge/cwd-transition-controller.ts`
- `src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session-fixture.ts`
- `src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts`
- `src/main/adapters/codex-cli/sdk-bridge/index.ts`
- `src/main/adapters/codex-cli/sdk-bridge/message-controller.ts`
- `src/main/adapters/codex-cli/sdk-bridge/pending-turn-queue.ts`
- `src/main/adapters/codex-cli/sdk-bridge/resume-path-await.ts`
- `src/main/adapters/codex-cli/sdk-bridge/session-command-controller.test.ts`
- `src/main/adapters/codex-cli/sdk-bridge/session-command-controller.ts`
- `src/main/adapters/codex-cli/sdk-bridge/session-retirement.ts`
- `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts`
- `src/main/adapters/codex-cli/sdk-bridge/types.ts`
- `src/main/adapters/grok-build/__tests__/pending-outgoing.test.ts`
- `src/main/adapters/grok-build/pending-outgoing.ts`
- `src/main/adapters/grok-build/runtime-types.ts`
- `src/main/adapters/grok-build/transport-recovery.ts`
- `src/main/adapters/grok-build/turn-queue.ts`

### Limits and handoff

- No Git commit/index/ref changes; no provider credentials, user databases/transcripts, live provider calls, deployments, installations, process/window/listener actions, or delegation. Existing scan records and other workers' changes were preserved.
- All source writes stayed under `src/main/adapters/`; task notes and disposable validation output stayed in the assigned runtime workspaces. Personal MCP task ownership belongs to the lead, so this worker record is the progress source.
- The lead owns integrated full-suite/typecheck/build, final archives/indexes and acceptance. Main-process changes need a user-approved development/runtime restart before the running app uses them; none was attempted.
- This is an implementation handoff, not lead acceptance or new paired-review coverage. No remaining in-scope blocker.
