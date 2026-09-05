---
review_id: 269
reviewed_at: 2026-09-04
baseline_commit: 072dd7a284eebc2752dab7e5d5505aa2ee480b77
coverage_kind: authorized-remediation
expired: true
expiry_reason: "Bounded uncommitted implementation verification; no whole-file exemption from future review."
---

# Project code quality remediation

All **14 functional/security defects and four LOW items** accepted in [REVIEW_268](REVIEW_268_project-code-quality-scan.md) are implemented. Final typecheck, full tests and production build passed. The completed execution plan is [PLAN_48](../../plans/recent-3-days/PLAN_48_project-code-quality-remediation.md).

This is a code delivery and bounded implementation verification, not a new exhaustive project audit. Three ordinary Codex workers owned disjoint areas; the lead implemented security/storage fixes and integrated all four tracks. The deep-review and simple-review skills were not used.

## Scope and decisions

- Preserve authentication and external read-only MCP restrictions; reject missing HTTP authentication before constructing the transport server.
- Preserve current Relay response limits, owner/generation fencing, task retention predicates and handoff ownership semantics. No schema migration, provider configuration change, dependency update or public tool schema change.
- Keep the current working checkout, baseline commit and unrelated scan records intact. No Git index/ref/commit operation, deployment, installed-bundle replacement, native rebuild or live host lifecycle action.
- Changed files, line counts and hashes are captured in the source manifest. All touched source/tests stay at or below 500 lines; the two long task suites and adapter fixtures were split by responsibility.
- Final records follow the review-driven-fix routing in ref/reviews/INDEX.md; a separate changelog/README update is unnecessary for these fixes and internal refactors.

## Disposition of accepted findings

| Finding | Severity | Result and permanent regression |
| --- | --- | --- |
| coordination-01 | HIGH | Hook auth uses the matched Fastify route for canonical, encoded and absolute-form targets. MCP POST additionally rejects missing/inconsistent caller auth. HookServer and HTTP transport regressions retain valid per-session/global cases and external guards. |
| desktop-01 | HIGH | PowerShell source is constant; the selected sound path is passed only through an environment value and consumed as URI data. Windows command-capture regressions cover subexpressions, quoting, Unicode and UNC paths without launching PowerShell. |
| remote-01 | HIGH | Daemon writes await bounded Worker admission one chunk at a time. Progress renews the stall deadline; incomplete-frame teardown resets the route. Real projector/validator/daemon/bridge tests deliver roughly 1 MiB and 3 MiB event responses plus the 4 MiB Core ceiling with delayed credit. |
| runtime-01 | MEDIUM | Claude approval defaults to the original pending tool input while honoring explicit replacements, including an empty object. The real Server Core caller/responder regression preserves Edit arguments. |
| runtime-02 | MEDIUM | Strict rollback seals/wakes input and calls Query.close before waiting for stream termination, releasing registration only after proof. Timeout/failure, late attachment and ordinary-close controls remain covered. |
| runtime-03 | MEDIUM | Pre-echo Grok deletion aborts the exact RPC, unwinds the local wait, then retires the old transport before processing another prompt. Missing terminal response, echo/cancel winner and replacement failure are covered. |
| desktop-02 | MEDIUM | Local Diff revalidates on activation while retaining useful history selection and rejecting stale identity results. Actual-hook activation regressions cover changes received while hidden. |
| desktop-03 | MEDIUM | Diff refresh tracks a contiguous window separately from cached history and uses the new cursor when overlap is unproven. Both Local and Remote panel regressions retain every row after a 51-change burst. |
| desktop-04 | MEDIUM | Profile choice plus optional Remote activation is one queued intent. Newer Local/header/profile-manager choices fence the second persistence call. Actual App callback and snapshot-hook tests cover ordering and older failures. |
| desktop-05 | MEDIUM | Explicit Browser show is wired from bootstrap to owner-qualified event-bus/IPC/preload and Local session/IAB navigation. visible is true only after actual presentation checks; five-second expiry, wrong owner, repeat/superseding request and teardown resolve safely. |
| remote-02 | MEDIUM | Human text consistently allows TAB/LF/CR; identifiers and JSON keys retain strict controls, byte/depth/node/cycle bounds and redaction. Actual multiline history and inbound text reach intended gateway flows. |
| remote-03 | MEDIUM | Production startup resolves the configured bot open-id through the authenticated official SDK; the mapper removes only that bot's leading group mention. SDK dispatcher/gateway tests invoke select/unsubscribe correctly and preserve unrelated mentions and private text. |
| coordination-02 | MEDIUM | Enter resolves actual checkout and caller HEAD through Git, without deriving the repository from metadata layout. Exit compares common-directory identity and the leased checkout. Isolated real Git tests cover submodules, linked checkouts, separate Git directories and a foreign repository. |
| coordination-03 | MEDIUM | Session deletion and retention capture doomed task ids and clear surviving blocks/blockedBy within the same transaction. Cleanup failure rolls back owner/tasks; pin/age/activity/lease guards and session rename are preserved. |
| coordination-04 | LOW | Removed the unused skip/distinct-team helpers and clear-team branch, including facade/type/test remnants. The remaining reassignOwner preserves team, edges and updated_at; live handoff/rollback tests retain their guarantees. |
| runtime-04 | LOW | One typed Codex pending-turn queue owns input, deferred user event and handoff metadata across all seven mutation owners. Combined cwd/requeue/delete/consume tests preserve attachment and snapshot ownership. |
| desktop-06 | LOW | Local/Remote share the paging/refresh state and continuity transitions while keeping their own source identity, authorization and read implementation. |
| LEAD-01 | LOW | The existing four installer cases now use Vitest and the default scripts test glob, so the normal test command exercises them. The installer itself is unchanged and was not run. |

## Integration verification

The lead reran the repository review-expiry inventory, checked the new boundaries and their callers, retained worker manifests unchanged, and added two cross-scope fixture corrections exposed by the first full suite: the worktree handler fixture now supplies the verified Git queries, and the Relay client/router fixture obeys bounded asynchronous Core output. The fixture changes retain the original roundtrip, cancellation and lease assertions. An unchanged Issues retry test also failed once at a synchronous DOM assertion; its isolated suite passed. The test now awaits the asynchronous error text while retaining request and stable-retry checks.

- Focused lead checks: security/installer 5 files / 48 tests; isolated Git identity 4 files / 17 tests; storage and handoff 140 tests, with a corrected test-only import rechecked. The split task-handler suite retains all 44 cases. Cross-scope fixture recheck: 2 files / 23 tests.
- Worker focused checks: runtime 46 files / 243 tests; remote 33 files / 256 tests; desktop 34 files / 232 tests. These overlap the full suite and must not be added as unique coverage totals.
- Project typecheck and architecture checks: passed. A missing test-only type import after splitting was corrected before the final typecheck.
- Complete test suite: **1,022 files / 6,335 tests passed**, with two skipped files / three skipped cases (two opt-in live-provider cases and one Linux-only case). Final exit code 0, 338.78 seconds. The first integrated run and its three resolved test issues are recorded separately.
- Production build: passed; main, preload, renderer and build metadata generated under the ignored build directory. No package installation or running-instance replacement.
- Entrypoint graph: 1,613 reachable runtime modules; the 18 non-root modules are test-used fixtures/helpers. The existing SQL asset and two computed runtime loaders are explicitly accounted for; graph reachability does not prove symbol-level use or exhaustive correctness.
- Obsolete handoff symbol/policy search and Codex old-array search: no production/test matches. IPC channel registration, preload forwarding and renderer consumption remain synchronized and tested.
- Native SQLite fingerprint: unchanged; the existing Electron-compatible wrapper exercised real in-memory SQLite without rebuilding the binding.

## Residual risk and deployment boundary

- Windows PowerShell/MediaPlayer execution, OS-level Browser focus/painting and real Feishu/network throughput were not exercised. Their code paths were validated with command capture, fake Electron objects and mocked SDK/stream boundaries. Browser show expires after five seconds and then reports invisible.
- The task repair prevents new dangling references through supported deletion paths; it does not inspect or rewrite a user's existing database. JSON dependency arrays still require a survivor scan on deletion. A schema redesign is outside this bounded remedy.
- Existing malformed worktree leases are not silently retargeted. Repository identity, clean-state and durable-reference checks still reject unsafe cleanup.
- Main/preload changes require an approved restart of the relevant running instance to become active. Worker/daemon and Feishu changes require their normal separately authorized release/restart. The built checkout has not been installed, restarted or deployed.
- No accepted in-scope source item remains intentionally deferred. These checks provide evidence for the changed paths, not a claim that the entire personal project has no other defects.

## Evidence and exact changed scope

The [evidence index](project-code-quality-remediation-evidence/README.md) links the accepted worker handoffs, focused checks, final full-suite/typecheck/build logs, source manifest and integrated validation metadata. Scope is the changed code and related regression contracts; `expired: true` prevents this uncommitted, bounded delivery from granting whole-file review exemptions.

```review-scope
scripts/install-local-macos.test.mjs
src/clients/relay/stream-client.test.ts
src/gateways/feishu/bot-identity.test.ts
src/gateways/feishu/mapper.ts
src/gateways/feishu/message-semantics.test.ts
src/gateways/feishu/runtime.ts
src/gateways/feishu/sdk.ts
src/gateways/im/core-bounds.ts
src/gateways/im/redaction.ts
src/gateways/im/text-policy.test.ts
src/gateways/im/text-policy.ts
src/gateways/im/validation.ts
src/hosts/daemon/frame-writer.ts
src/hosts/daemon/types.ts
src/hosts/local-worker/daemon-frame-channels.test.ts
src/hosts/local-worker/daemon-frame-channels.ts
src/hosts/local-worker/frame-bridge-types.ts
src/hosts/local-worker/frame-bridge.test.ts
src/hosts/local-worker/frame-bridge.ts
src/hosts/local-worker/frame-output-waiters.test.ts
src/hosts/local-worker/relay-output-capacity.test.ts
src/main/adapters/claude-code/sdk-bridge/permission-responder-core.test.ts
src/main/adapters/claude-code/sdk-bridge/permission-responder-core.ts
src/main/adapters/claude-code/sdk-bridge/send-validation.ts
src/main/adapters/claude-code/sdk-bridge/session-lifecycle-core.test.ts
src/main/adapters/claude-code/sdk-bridge/session-lifecycle-core.ts
src/main/adapters/claude-code/sdk-bridge/session-rollback-core.test.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts
src/main/adapters/codex-cli/__tests__/consume-fork-fixture.ts
src/main/adapters/codex-cli/__tests__/per-session-codex-env.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.restart.test.ts
src/main/adapters/codex-cli/__tests__/wire-prefix-e2e.test.ts
src/main/adapters/codex-cli/__tests__/wire-prefix-fixture.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-early-rollback.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-fixture.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-new-latency.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/cwd-transition-controller.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/message-controller-handoff.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/pending-turn-queue.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/session-lifecycle-coordinator.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/session-retirement.test.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/trusted-continuation-new.test.ts
src/main/adapters/codex-cli/sdk-bridge/constants.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-validate.ts
src/main/adapters/codex-cli/sdk-bridge/cwd-transition-controller.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session-fixture.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.test.ts
src/main/adapters/codex-cli/sdk-bridge/fork-session/create-forked-session.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/codex-cli/sdk-bridge/pending-turn-queue.ts
src/main/adapters/codex-cli/sdk-bridge/resume-path-await.ts
src/main/adapters/codex-cli/sdk-bridge/session-command-controller.test.ts
src/main/adapters/codex-cli/sdk-bridge/session-command-controller.ts
src/main/adapters/codex-cli/sdk-bridge/session-retirement.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/adapters/codex-cli/sdk-bridge/types.ts
src/main/adapters/grok-build/__tests__/pending-outgoing.test.ts
src/main/adapters/grok-build/pending-outgoing.ts
src/main/adapters/grok-build/runtime-types.ts
src/main/adapters/grok-build/transport-recovery.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/agent-deck-mcp/__tests__/enter-exit-worktree.handler.test.ts
src/main/agent-deck-mcp/__tests__/enter-exit-worktree.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts
src/main/agent-deck-mcp/__tests__/task-crud-delete.test.ts
src/main/agent-deck-mcp/__tests__/task-crud-read.test.ts
src/main/agent-deck-mcp/__tests__/task-crud.fixture.ts
src/main/agent-deck-mcp/__tests__/task-crud.test.ts
src/main/agent-deck-mcp/__tests__/transport-http-extra-auth.test.ts
src/main/agent-deck-mcp/__tests__/worktree-repository-identity.test.ts
src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts
src/main/agent-deck-mcp/transport-http.ts
src/main/browser-use/__tests__/show-fakes.ts
src/main/browser-use/browser-presentation-controller.ts
src/main/browser-use/browser-presentation-runtime.ts
src/main/browser-use/browser-show-controller.test.ts
src/main/browser-use/browser-show-controller.ts
src/main/browser-use/browser-show-ipc.test.ts
src/main/browser-use/browser-show-runtime.ts
src/main/browser-use/engine/registry.ts
src/main/browser-use/engine/surface.ts
src/main/browser-use/engine/tab.ts
src/main/browser-use/operation-executor.ts
src/main/browser-use/view-host.ts
src/main/event-bus.ts
src/main/hook-server/server.test.ts
src/main/hook-server/server.ts
src/main/index/__tests__/bootstrap-wiring-observability.test.ts
src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts
src/main/index/bootstrap-infra.ts
src/main/index/bootstrap-wiring.ts
src/main/ipc/browser.ts
src/main/notify/__tests__/sound-windows.test.ts
src/main/notify/sound.ts
src/main/session/worktree-transition/git-cleanup.ts
src/main/session/worktree-transition/git-repository.ts
src/main/store/__tests__/session-task-dependencies.test.ts
src/main/store/__tests__/task-repo-delete.test.ts
src/main/store/__tests__/task-repo-handoff.test.ts
src/main/store/__tests__/task-repo-team.test.ts
src/main/store/__tests__/task-repo.fixture.ts
src/main/store/__tests__/task-repo.test.ts
src/main/store/session-repo/lifecycle.ts
src/main/store/session-repo/worktree-transition-delete.ts
src/main/store/task-dependency-cleanup.ts
src/main/store/task-repo.ts
src/main/store/task-repo/_deps.ts
src/main/store/task-repo/task-repo-delete.ts
src/main/store/task-repo/task-repo-handoff.ts
src/preload/api/browser.ts
src/renderer/App.tsx
src/renderer/components/SessionDetail/RemoteDiffPanel.tsx
src/renderer/components/SessionDetail/__tests__/file-change-continuity.test.tsx
src/renderer/components/SessionDetail/file-change-pages.ts
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionDetail/remote-diff-continuity.test.tsx
src/renderer/components/SessionDetail/use-file-change-pages.ts
src/renderer/components/SessionDetail/use-file-changes.ts
src/renderer/hooks/use-browser-show.test.tsx
src/renderer/hooks/use-browser-show.ts
src/renderer/remote-host/RemoteIssuesPanel.test.tsx
src/renderer/remote-host/source-selection-intents.test.tsx
src/renderer/remote-host/use-remote-host-snapshot.ts
src/shared/browser-view.ts
src/shared/ipc-channels.ts
vitest.config.ts
```

## Follow-ups

No accepted source fix is deferred. Live platform acceptance and release/restart remain separately authorized operations; they are not part of this code-only delivery.
