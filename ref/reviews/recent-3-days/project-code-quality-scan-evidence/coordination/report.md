**Coordination project scan — 2026-09-04-project-scan**

Baseline and final inspected HEAD: `072dd7a284eebc2752dab7e5d5505aa2ee480b77` (`main`). Source and the repository Git state remained unchanged; the final `git status --short` was empty. This was an ordinary independent scan, without paired reviewers, review skills, source fixes, or recursive delegation.

The scan found three reproducible defects and one confirmed obsolete implementation family. Severity is relative to this personal desktop application and its supported local collaboration workflows.

| ID | Severity / confidence | Classification | Result |
| --- | --- | --- | --- |
| coordination-01 | HIGH / high | Authentication defect | Noncanonical HTTP request targets bypass HookServer authentication. Hook events can be forged; MCP exposes external-allowed metadata reads. |
| coordination-02 | MEDIUM / high | Functional defect | `enter_worktree` from an initialized submodule creates a worktree of the superproject, then its recorded repository identity makes exit preflight fail. |
| coordination-03 | MEDIUM / high | Data integrity defect; architecture opportunity | Deleting or expiring a session cascades its tasks without cleaning dependency UUIDs from surviving teammates' tasks. |
| coordination-04 | LOW / high | Confirmed dead code / obsolete compatibility | Removed handoff task-policy options still have test-only implementations, facade methods, types, and dedicated tests. |

**coordination-01 — Bind authentication to the matched route, not the raw URL prefix**

Primary location: `src/main/hook-server/server.ts:61`. Supporting locations: `src/main/hook-server/server.ts:70`, `src/main/hook-server/server.ts:211`, `src/main/agent-deck-mcp/transport-http.ts:66`, `src/main/agent-deck-mcp/types.ts:80`, `src/main/agent-deck-mcp/tools/helpers.ts:150`, `src/main/session/manager.ts:182`.

```ts
    this.app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/hook/')) {
        this.checkAuth(
          request.headers['authorization'],
          this.expectedHookAuthBuf,
          reply,
```

Trigger and trust boundary: a local HTTP client can reach the configured loopback HookServer port but has neither token. Fastify matches decoded paths and absolute-form HTTP request targets, whereas the application makes the authentication decision using the original request URL. With no Authorization header, `/hook/test` and `/mcp` return 401; `/%68ook/test`, `/h%6fok/test`, `http://localhost/hook/test`, `/%6dcp`, and `http://localhost/mcp` all reach the same protected handlers with status 200 and no `auth` object. This is a real loopback boundary failure; this report does not claim an Internet-exposed listener.

Production hook path: `src/main/index/bootstrap-infra.ts:163` creates HookServer, provider initialization registers `src/main/adapters/claude-code/hook-routes.ts:73`, and the route helper translates/emits at `src/main/hook-server/route-diagnostics.ts:408`. The production event sink calls `sessionManager.ingest` at `src/main/index/bootstrap-infra.ts:185`. For an unclaimed CLI session, `src/main/session/manager-ingest-pipeline.ts:116` does not discard the hook; `src/main/session/manager.ts:210` ensures the session, persists the event, advances its state, and publishes the event. `translateUserPromptSubmit` produces a user message at `src/main/adapters/claude-code/hook-lifecycle-translate.ts:24`; `translateSessionEnd` at line 228 produces session-end, which closes the CLI record at `src/main/session/manager-ingest-pipeline.ts:390`.

Observed consequence: an isolated in-memory database using the real SessionManager and repository methods acquired a new `source='cli'` session and a persisted user event containing the supplied text. A subsequent production-translated session-end changed its lifecycle to `closed`. The lead independently mounted actual `buildHookRoutes` and verified tokenless encoded/absolute-form userpromptsubmit requests emitting these events; its verification is recorded in `ref/reviews/recent-3-days/project-code-quality-scan-evidence/lead/hook-verification.md`. These two probes deliberately separate HTTP routing from durable ingestion; neither contacted the running app.

MCP consequence and limit: missing auth becomes `EXTERNAL_CALLER_SENTINEL` in `src/main/agent-deck-mcp/transport-http.ts:66`, and `withMcpGuard` still rejects all 16 external-disallowed tools. The probe verified those guards. `list_sessions` bypasses relationship filtering for the external sentinel at `src/main/agent-deck-mcp/tools/handlers/list.ts:118`, and `get_session` returns `projectSession` at `src/main/agent-deck-mcp/tools/handlers/get.ts:25`. With an in-memory fixture they exposed session id, adapter, configured Gateway/provider identifier, cwd, title, lifecycle, last-event time, team metadata, and spawn metadata. `task_list` returned an empty scope. The evidence does **not** establish unauthenticated MCP spawn/send/shutdown, task writes, issue writes, `task_get`, or `list_session_events`; no raw provider transcript is exposed by these read handlers. SDK-owned hook deduplication also remains a counter-boundary; the demonstrated history/state poisoning uses an unclaimed CLI identity.

Validation: `auth-path.test.ts` passed (one test), `auth-consequences.test.ts` passed (two tests), and the existing HookServer and external-guard tests passed. All fixtures and logs are adjacent to this report. No socket listened and no provider process started.

Fix direction: apply authentication using explicit route metadata or per-route/onRequest hooks, so every equivalent request target has the same policy. Add a transport-level assertion that `/mcp` received a valid authentication result. Retain external read/write distinctions. Add canonical, encoded, and absolute-form regression cases. No product-policy decision is required to restore the existing token boundary.

**coordination-02 — Resolve the caller repository independently of its Git directory layout**

Primary location: `src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts:87`. Supporting locations: `src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts:114`, `src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts:255`, `src/main/agent-deck-mcp/tools/handlers/enter-worktree.ts:94`, `src/main/session/worktree-transition/git-cleanup.ts:104`.

```ts
    const commonDirAbs = path.isAbsolute(gitCommonDir)
      ? gitCommonDir
      : path.resolve(callerCwd, gitCommonDir);
    return path.dirname(commonDirAbs);
```

Ordinary sequence: open an Agent Deck session in an initialized Git submodule, then call `enter_worktree({startPoint:'HEAD', worktreePath:<new absolute fixture path>})`. A standard submodule's common Git directory is `<superproject>/.git/modules/<submodule>`. Taking its parent produces `<superproject>/.git/modules`, which Git discovers as belonging to the superproject. Both `rev-parse HEAD^{commit}` and `worktree add --detach` therefore run against the parent repository. This contradicts the current public `startPoint` description in `src/main/agent-deck-mcp/tools/schemas/lifecycle.ts:60`, which says resolution occurs in the caller repository.

Consequence: the created detached worktree contains the superproject's tracked file and no root submodule source file, even though the requested HEAD is the submodule's. The same lease records `.git/modules` as `mainRepo`; exit preflight obtains the actual superproject root from the new worktree and rejects it as a repository mismatch. The agent is moved into the wrong codebase and cannot complete the normal automatic exit path. No existing branch/ref is changed by the reproduction.

Production chain: public tool registration -> `enterWorktreeHandler` -> `prepareEnterWorktree` -> `resolveMainRepo` -> `resolveStartCommit` -> `createPreparedWorktree` -> durable transition/cwd switch. `exitWorktreeHandler` subsequently calls `preflightStructuredWorktreeExit`.

Validation: `submodule-worktree.test.ts` used disposable repositories exclusively below this track's allowed temporary directory, with system/global Git configuration disabled and an empty template/hook directory. It called the real preparation and creation functions: selected superproject HEAD=true, selected submodule HEAD=false, superproject file present=true, submodule root source file present=false. The extended probe also verified the real exit preflight rejects the stored `mainRepo` (`not leased main repo`). One test passed. The existing preparation tests cover ordinary `.git` directories and detached worktrees; their current fixtures do not exercise initialized submodules.

Fix direction: preserve an explicit Git repository identity and run revision/worktree operations from the caller's actual repository (or with an explicit verified Git directory). Derive display/default-directory paths separately; the parent of `--git-common-dir` is not a general repository-root API. Ensure cleanup checks use that same identity. If submodule cwd support is intentionally excluded, reject it before creating anything rather than silently operating on the superproject; such an exclusion would be a user-owned compatibility decision.

**coordination-03 — Session cascade deletion bypasses task dependency cleanup**

Primary locations: `src/main/store/session-repo/worktree-transition-delete.ts:31`, `src/main/store/session-repo/lifecycle.ts:217`, `src/main/store/schema.sql:236`. Supporting location: `src/main/store/task-repo/task-repo-delete.ts:44`.

```ts
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    deleteSessionHandOffAliasesForSessionWithDb(db, sessionId);
```

Ordinary sequence: two sessions have tasks in the same team. B's task lists A's task in `blockedBy`, with the inverse edge in A's `blocks`. A closes; the user deletes A from History, or the normal history-retention job expires it while B remains active. `tasks.owner_session_id` uses `ON DELETE CASCADE`, so A's task disappears. Both session deletion paths omit `cleanupBlocksReferences`; the schema has no task-delete trigger that cleans the JSON arrays.

Consequence: B's live task still reports a UUID of a nonexistent upstream task through `task_get`/`task_list`. The explicit `task_delete` path cleans these edges, so the graph depends on which supported deletion path was used. This is stale task dependency data, not a claim that the application automatically executes or blocks work based on those fields.

Production chain: History deletion -> `SessionManager` lifecycle deletion -> `sessionRepo.delete` -> `deleteSessionWithWorktreeGuard`; retention -> `SessionLifecycleScheduler` (`src/main/session/lifecycle-scheduler.ts:249`) -> `batchDeleteHistory`; both delete sessions and let SQLite cascade tasks. The surviving caller's MCP `task_get` returns the remaining stored `blockedBy` array unchanged.

Validation: `task-lifecycle.test.ts` passed all three in-memory SQLite cases. Explicit task deletion removed B's dependency as a control; direct session deletion left it; normal retention deletion also left it, and the real `taskGetHandler` returned the dangling UUID to active owner B. Current `src/main/store/schema.sql` was loaded with foreign keys enabled. Existing task-repository tests passed, but did not cover this cross-owner session-cascade sequence.

Architecture opportunity with an existing cost: task dependencies are two independently stored JSON arrays. All correctness cleanup currently belongs to an explicit application deletion method, while another deletion owner is SQLite's session FK cascade. Moreover, explicit cleanup reads every surviving task synchronously (`src/main/store/task-repo/task-repo-delete.ts:45`) and parses/filter its arrays, including unrelated tasks. These are current correctness and maintenance costs, not a scale benchmark.

Fix direction: for a narrow repair, collect doomed task ids and clean surviving dependency references inside each session-deletion transaction. For a larger architecture change, use an indexed dependency relation with foreign keys and derive `blocks`/`blockedBy` projections. Choosing the schema change over the bounded repair is a user-owned architecture decision; this scan does not authorize either implementation.

**coordination-04 — Retire the obsolete handoff task-policy implementations**

Classification: **confirmed dead production methods/branch**, not an unreachable module. Primary locations: `src/main/store/task-repo/task-repo-handoff.ts:60`, `src/main/store/task-repo/task-repo-handoff.ts:70`, `src/main/store/task-repo/task-repo-handoff.ts:126`; facade/type locations: `src/main/store/task-repo.ts:83`, `src/main/store/task-repo/_deps.ts:166`.

```ts
    if (opts.policy === 'clear-team') {
      sql = `UPDATE tasks SET owner_session_id = ?, team_id = NULL WHERE owner_session_id = ?`;
    } else {
      // 'preserve-team'
      sql = `UPDATE tasks SET owner_session_id = ? WHERE owner_session_id = ?`;
    }
```

Current production behavior: `transferHandOffResources` always invokes `reassignOwner(...,{policy:'preserve-team'})` at `src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts:319`; its rollback uses the same policy at line 353. The current handoff schema exposes no clear/skip/adopt-teammates policy. Every production caller of the task-repository facade uses named CRUD/list or these preserve-team calls. `applyHandOffSkipPolicy`, `findOwnedDistinctTeamIds`, and the clear-team branch are reached only by their own facade wiring and tests. This leaves more than sixty lines of obsolete SQL/transfer implementation, policy types, duplicated method declarations, forwarding code, and dedicated test maintenance representing behavior the product no longer exposes.

Verification breadth: repository-wide symbol/policy searches covered `src/`, `scripts/`, `resources/`, and package metadata; the saved output is `task-policy-references.txt`. Checked computed task-repository access/spreads/reflection, the only production `createTaskRepo` construction, all production facade callers, MCP registration/current lifecycle schemas, `src/main/ipc/sessions.ts` (only `list`), the configured eleven headless build roots, and package/build entrypoint metadata. No hidden tool/IPC/packaging registration invokes these members; the package is private with no public task-repository export surface. The Server Core task service has its own repository and does not call these methods. This is a method-level leftover that a reachable-module graph would not exclude.

Counter-evidence: the containing handoff module remains live, `reassignOwner` preserve-team remains live, and `cleanupBlocksReferences` remains necessary for ordinary explicit task deletion. Those must not be removed with the obsolete functions. Dedicated old-policy tests still execute (including the currently passing task-repository suite); test execution is not a production caller.

Fix direction: remove the clear-team option/branch, skip/distinct-team helpers, facade/type declarations, stale old-policy documentation, and tests that exist solely to enforce those retired policies. Preserve current task/team transfer semantics and ordinary dependency cleanup. There is no current compatibility caller to preserve; intentionally restoring a removed task-policy feature would be a separate product decision.

**Coverage and search breadth**

The exact primary inventory was read from `ref/reviews/recent-3-days/project-code-quality-scan-evidence/scopes/coordination-scope.txt`: 630 tracked files, comprising 390 production files and 240 tests/fixtures under the filename classification below. Every assigned file was inventoried. Direct source/assertion/setup inspection covered 114 assigned files plus seven contextual source files outside the assigned area. Direct inspection means relevant bodies/excerpts were read; it does not mean every line or every branch of each file was reviewed. Many large comments were omitted by the disposable reader, and truncated tool output was followed up only where needed for a finding.

| Area | Inventoried | Production | Test/fixture | Directly inspected files/excerpts |
| --- | ---: | ---: | ---: | ---: |
| `src/composition` | 7 | 5 | 2 | 3 |
| `src/contracts` | 65 | 36 | 29 | 3 |
| `src/core` | 6 | 3 | 3 | 2 |
| `src/main/agent-deck-mcp` | 105 | 65 | 40 | 40 |
| `src/main/diff-review` | 2 | 1 | 1 | 2 |
| `src/main/hook-server` | 13 | 7 | 6 | 5 |
| `src/main/plan-review` | 8 | 4 | 4 | 2 |
| `src/main/session` | 217 | 127 | 90 | 27 |
| `src/main/store` | 139 | 86 | 53 | 23 |
| `src/main/teams` | 10 | 6 | 4 | 5 |
| `src/shared` | 58 | 50 | 8 | 2 |

Workflows traced: Hook/MCP identity acquisition and external guards; session discovery/event visibility; task and issue owner/team checks; message enqueue/claim/delivery/retry/retention; handoff transfer transaction, late-message cutover, alias lineage and source finalization; worktree preparation/observation/switch/cleanup/recovery; plan/diff request ownership across handoff; session deletion/retention; continuation target-capacity resolution and bounded user-tail capture; core access dispatch and composition lifetime ordering; canonical file-change path capture/read projections.

Searches covered ownership/caller/session/team relationships, named and computed task-repository calls, SQL deletion/query limits, state/transaction/compensation sites, TODO/compatibility markers, and source/import registrations in the relevant families. Full-repository searches were used for potential dead methods and production callers. Installed Fastify/router/injection implementation was read to explain the URL behavior; no live credential, user database, or provider transcript was read. The lead's full production-entrypoint graph and integrated typecheck remain separate validation owned by the lead.

**Retained boundaries and exclusions**

- Revalidated against `ref/reviews/recent-3-days/REVIEW_267_compatibility-dead-code-audit.md`; no deleted Image MCP, retired Local Browser front, or removed module is reported here.
- Handoff aliases, latest-owner issue checks, runtime identity/recovery, preserved worktree leases, and provider-observed tool correlation remain necessary current behavior.
- Message delivery's startup handling of uncertain `delivering` rows is an explicit fail-closed/at-most-once recovery choice with tests. It is not classified as obsolete or as an accidental retry defect.
- Plan/diff late-decision ownership and current task preserve-team transfer remain live; their regression tests passed.
- No architecture recommendation is based solely on file size, naming, wrapper style, or speculative platform/scale assumptions.

Remaining gaps: most continuation checkpoint folding/background-worker, summarizer/oneshot, context-window policy, file snapshot/storage worker, token-usage rollup, contract parser/type, and shared utility files received inventory/search coverage rather than a full body-by-body analysis. No live provider handoff, crash/restart, packaged application, Windows runtime, remote service, Browser UI, real listener attack, or end-to-end concurrent filesystem mutation was executed. Some plausible exception/cleanup edge cases and platform path assumptions were not promoted without a completed supported trigger/consequence proof. This is a bounded scan, not exhaustive dynamic or line-by-line coverage.

**Validation and evidence**

All final targeted checks passed:

- Existing tests: 10 files / 118 tests, single worker, using `scripts/test-electron.mjs` through `pnpm run test`; exact files in `focused-test-files.txt`, output in `focused-tests-results.txt`.
- Isolated probes: four files / seven tests: `auth-path.test.ts` (1), `auth-consequences.test.ts` (2), `submodule-worktree.test.ts` (1), `task-lifecycle.test.ts` (3). Final logs use matching `*-results.txt` names.
- Source/index/ref/commit state: final HEAD unchanged and tracked status empty. Test configurations disable the test cache and place Vite/runtime temporary output within this track's directory. The Electron-compatible SQLite binding was used in place; no binding rebuild or dependency change occurred.
- An initial probe command used `pnpm test --config`, which pnpm rejected before running tests. It was corrected to `pnpm run test --config`. The first temporary consequence test also encountered a Vite CommonJS import-resolution failure; using `createRequire` from the repository package anchored the already-installed SQLite module and the final run passed. Neither failure was an application defect.

Reproduction commands, run from the repository root (all written/generated evidence remains under the track directory):

```sh
SCAN_EVIDENCE=/tmp/agent-deck-scan/2026-09-04-project-scan/coordination
TMPDIR="$SCAN_EVIDENCE/runtime-tmp" pnpm run test --config "$SCAN_EVIDENCE/focused.config.cjs"
TMPDIR="$SCAN_EVIDENCE/runtime-tmp" pnpm run test --config "$SCAN_EVIDENCE/vitest.config.cjs" "$SCAN_EVIDENCE/auth-path.test.ts"
TMPDIR="$SCAN_EVIDENCE/runtime-tmp" pnpm run test --config "$SCAN_EVIDENCE/vitest.config.cjs" "$SCAN_EVIDENCE/auth-consequences.test.ts"
TMPDIR="$SCAN_EVIDENCE/runtime-tmp" pnpm run test --config "$SCAN_EVIDENCE/vitest.config.cjs" "$SCAN_EVIDENCE/submodule-worktree.test.ts"
TMPDIR="$SCAN_EVIDENCE/runtime-tmp" pnpm run test --config "$SCAN_EVIDENCE/vitest.config.cjs" "$SCAN_EVIDENCE/task-lifecycle.test.ts"
```

**Actual directly inspected source/test files (bodies or relevant excerpts)**

The same list is in `directly-inspected-files.txt`; the assigned inventory is in `inventory.txt`. Files outside the primary inventory were read only to establish entrypoints, callers, or consequences and are not claimed as another track's complete coverage.

```text
src/composition/controller.ts
src/composition/runtime.ts
src/composition/session-console-runtime.ts
src/contracts/access.ts
src/contracts/grant-policy.ts
src/contracts/workspace-sandbox.ts
src/core/safe-diagnostic-text.ts
src/core/session-console.ts
src/main/adapters/claude-code/adapter-init-host.ts
src/main/adapters/claude-code/hook-lifecycle-translate.ts
src/main/adapters/claude-code/hook-routes.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/grok-build/message-controller.ts
src/main/agent-deck-mcp/__tests__/enter-exit-worktree.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts
src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/mcp-session-token-map.ts
src/main/agent-deck-mcp/server.ts
src/main/agent-deck-mcp/tool-policy.ts
src/main/agent-deck-mcp/tools/handlers/_shared/default-impl-deps.ts
src/main/agent-deck-mcp/tools/handlers/append-issue-context.ts
src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts
src/main/agent-deck-mcp/tools/handlers/enter-worktree.ts
src/main/agent-deck-mcp/tools/handlers/exit-worktree.ts
src/main/agent-deck-mcp/tools/handlers/get.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/runtime-dependencies.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/source-finalization.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/worktree-preflight.ts
src/main/agent-deck-mcp/tools/handlers/list-session-events.ts
src/main/agent-deck-mcp/tools/handlers/list.ts
src/main/agent-deck-mcp/tools/handlers/report-issue.ts
src/main/agent-deck-mcp/tools/handlers/request-diff-review.ts
src/main/agent-deck-mcp/tools/handlers/request-plan-review.ts
src/main/agent-deck-mcp/tools/handlers/send.ts
src/main/agent-deck-mcp/tools/handlers/shutdown.ts
src/main/agent-deck-mcp/tools/handlers/spawn-link-registration.ts
src/main/agent-deck-mcp/tools/handlers/spawn-team.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/agent-deck-mcp/tools/handlers/task-create.ts
src/main/agent-deck-mcp/tools/handlers/task-delete.ts
src/main/agent-deck-mcp/tools/handlers/task-get.ts
src/main/agent-deck-mcp/tools/handlers/task-helpers.ts
src/main/agent-deck-mcp/tools/handlers/task-list.ts
src/main/agent-deck-mcp/tools/handlers/task-update.ts
src/main/agent-deck-mcp/tools/handlers/update-issue-status.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/tasks.ts
src/main/agent-deck-mcp/transport-http.ts
src/main/agent-deck-mcp/types.ts
src/main/diff-review/service.test.ts
src/main/diff-review/service.ts
src/main/hook-server/route-diagnostics-host.ts
src/main/hook-server/route-diagnostics.ts
src/main/hook-server/route-registry.ts
src/main/hook-server/server.test.ts
src/main/hook-server/server.ts
src/main/index/bootstrap-infra.ts
src/main/ipc/sessions.ts
src/main/plan-review/__tests__/service.test.ts
src/main/plan-review/service.ts
src/main/session/__tests__/manager-test-setup.ts
src/main/session/context-window/service.ts
src/main/session/continuation-context/handoff.ts
src/main/session/continuation-context/raw-user-tail.ts
src/main/session/continuation-context/resolver-core.ts
src/main/session/continuation-context/source-spool-raw-tail.ts
src/main/session/file-change-path-authority.ts
src/main/session/hand-off/cutover-coordinator.ts
src/main/session/hand-off/executor.ts
src/main/session/hand-off/ownership.ts
src/main/session/hand-off/target-resolver.ts
src/main/session/lifecycle-scheduler.ts
src/main/session/manager-enrich.ts
src/main/session/manager-ingest-pipeline.ts
src/main/session/manager.ts
src/main/session/manager/facade-core.ts
src/main/session/manager/hooks.ts
src/main/session/manager/session-registration.ts
src/main/session/worktree-transition/__tests__/git-cleanup-references.test.ts
src/main/session/worktree-transition/__tests__/transition-delivery.test.ts
src/main/session/worktree-transition/coordinator.ts
src/main/session/worktree-transition/git-cleanup.ts
src/main/session/worktree-transition/git-safety.ts
src/main/session/worktree-transition/recovery.ts
src/main/session/worktree-transition/state-machine.ts
src/main/session/worktree-transition/tool-invocation-registry.ts
src/main/session/worktree-transition/transition-delivery.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/__tests__/message-delivery-state.test.ts
src/main/store/__tests__/task-repo.test.ts
src/main/store/agent-deck-message-repo/gc.ts
src/main/store/agent-deck-message-repo/state-machine.ts
src/main/store/agent-deck-team-repo/team-crud.ts
src/main/store/db.ts
src/main/store/event-repo.ts
src/main/store/file-change-read-authority.ts
src/main/store/message-lifecycle-scheduler.ts
src/main/store/schema.sql
src/main/store/schema.ts
src/main/store/session-handoff-alias-repo.ts
src/main/store/session-repo/archive.ts
src/main/store/session-repo/lifecycle.ts
src/main/store/session-repo/worktree-transition-delete.ts
src/main/store/storage-maintenance/maintenance-engine.ts
src/main/store/storage-maintenance/scheduler.ts
src/main/store/task-repo.ts
src/main/store/task-repo/_deps.ts
src/main/store/task-repo/task-repo-crud.ts
src/main/store/task-repo/task-repo-delete.ts
src/main/store/task-repo/task-repo-handoff.ts
src/main/teams/__tests__/universal-message-watcher-durability.test.ts
src/main/teams/team-lifecycle-scheduler.ts
src/main/teams/universal-message-watcher/claimed-message-delivery.ts
src/main/teams/universal-message-watcher/enqueue.ts
src/main/teams/universal-message-watcher/index.ts
src/shared/file-change-path-authority.ts
src/shared/wire-prefix.ts
```
