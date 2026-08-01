---
review_id: 208
reviewed_at: 2026-07-31
baseline_commit: 6c4819855495e75b6a3fedbcce6be12342d4dd45
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and plan archival, rebucketing, and index maintenance are mechanical record work."
---

# REVIEW_208_compatibility-and-defect-audit: Compatibility cleanup and functional defect audit

## Scope and method

The review ran in two explicitly separate waves against baseline
`6c4819855495e75b6a3fedbcce6be12342d4dd45`.

- Wave 1 used three independent ordinary Codex sessions to identify compatibility-only logic.
  Repository-internal closed loops were removed directly. Public CLI/MCP, persisted-data, provider,
  filesystem, and bundled-resource candidates were held for user confirmation.
- The user approved removing the retired Codex `profile` rejection seam, persisted object-form
  `changeKind` readers, and a zero-production packaged-Codex PATH wrapper. Old screenshot-name
  cleanup, the Grok notification alias, valid-v61 row normalization, and the resources placeholder
  boundary were retained as live safeguards.
- Wave 2 used three new independent, fresh, read-only Codex sessions partitioned across
  state/persistence, adapters/runtime, and IPC/renderer. Every session used `gpt-5.6-sol` with
  `thinking=max`. Neither `simple-review` nor `deep-review` was invoked.
- The lead independently traced every reported producer/consumer, lifecycle, transaction, and UI
  state path. All fifteen findings survived adjudication.

```review-scope
resources/README.md
resources/bin/node-repl-browser-bootstrap.cjs
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/main/__tests__/cli-session-model-options.test.ts
src/main/adapters/__tests__/runtime-control-contracts.test.ts
src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts
src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-failure-cleanup.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/setttimeout-fallback-symmetry.test.ts
src/main/adapters/claude-code/sdk-injection.test.ts
src/main/adapters/claude-code/sdk-injection.ts
src/main/adapters/codex-cli/__tests__/codex-binary-layout.test.ts
src/main/adapters/codex-cli/app-server/node-repl-browser-bootstrap.ts
src/main/adapters/codex-cli/app-server/thread-params.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/codex-config-paths.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-thread-id-init.test.ts
src/main/adapters/codex-cli/sdk-bridge/codex-binary.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/grok-build/launch-child.ts
src/main/adapters/grok-build/resolve-grok-binary.ts
src/main/adapters/runtime-control-contracts.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.schema.test.ts
src/main/agent-deck-mcp/__tests__/target-runtime-schema.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/source-finalization.ts
src/main/agent-deck-mcp/tools/handlers/shutdown.ts
src/main/agent-deck-mcp/tools/handlers/spawn-runtime-selection.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/lifecycle.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/agent-deck-mcp/tools/schemas/target-runtime.ts
src/main/browser-use/engine/cdp.ts
src/main/browser-use/engine/registry.ts
src/main/browser-use/engine/tab.ts
src/main/browser-use/fronts/codex-pipe.ts
src/main/browser-use/session-browser.ts
src/main/cli.ts
src/main/codex-config/custom-agents.test.ts
src/main/codex-config/custom-agents.ts
src/main/codex-config/skills-installer.ts
src/main/diff-review/service.ts
src/main/event-bus.ts
src/main/index/bootstrap-wiring.ts
src/main/ipc/_helpers.ts
src/main/ipc/adapters.ts
src/main/ipc/images.ts
src/main/ipc/issues.ts
src/main/notify/visual.ts
src/main/session/continuation-context/__tests__/source-spool.test.ts
src/main/session/continuation-context/runtime.ts
src/main/session/continuation-context/service.ts
src/main/session/continuation-context/source-spool.ts
src/main/session/file-change-snapshots.ts
src/main/session/final-file-diff.ts
src/main/session/hand-off/__tests__/target-resolver.test.ts
src/main/session/hand-off/executor.ts
src/main/session/hand-off/target-resolver.ts
src/main/session/manager-enrich.ts
src/main/session/manager-team-coordinator.ts
src/main/session/manager.ts
src/main/session/manager/_deps.ts
src/main/session/manager/lifecycle.ts
src/main/session/oneshot-llm/codex-runner.ts
src/main/session/summarizer/index.ts
src/main/session/worktree-transition/coordinator.ts
src/main/store/__tests__/agent-deck-message-repo.test.ts
src/main/store/agent-deck-message-repo.ts
src/main/store/agent-deck-message-repo/_deps.ts
src/main/store/agent-deck-message-repo/crud.ts
src/main/store/agent-deck-message-repo/state-machine.ts
src/main/store/agent-deck-team-repo/index.ts
src/main/store/image-uploads.ts
src/main/store/schema.sql
src/main/store/session-repo/types.ts
src/main/store/task-repo.ts
src/main/teams/team-lifecycle-scheduler.ts
src/main/teams/universal-message-watcher/index.ts
src/preload/api/events.ts
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/PermissionsView.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/UploadedImageThumb.tsx
src/renderer/components/diff/renderers/TextDiffRenderer.test.tsx
src/renderer/components/diff/renderers/TextDiffRenderer.tsx
src/renderer/components/pending-rows/DiffReviewRow.tsx
src/renderer/components/permissions/ClaudePermissionsPanels.tsx
src/renderer/stores/session-store.ts
src/shared/ipc-channels.ts
src/shared/types.ts
src/shared/types/settings.ts
```

## Confirmed defect findings

| ID | Severity | Root cause and consequence | Disposition |
|---|---|---|---|
| D1-1 | HIGH | `validateExternalCaller` unconditionally trusts in-process callers. After committed handoff closes the source but preserves the current provider turn long enough to return the result, that closed predecessor can still invoke mutating MCP tools, including shutting down the successor. | Open; enforce durable lifecycle authorization for every real transport and regression-test a post-handoff second call. |
| D1-2 | MEDIUM | Pending message endpoint transfer independently rewrites both endpoints. A successor-to-source or source-to-successor row collapses into a pending successor self-message, bypassing the insertion invariant. | Open; terminalize collapsing rows or reject that ingress inside the same transaction. |
| D1-3 | MEDIUM | Teammate handoff adds the successor transactionally but removes the source only in later best-effort close cleanup. Crash or cleanup failure leaves both sessions active members. | Open; add one atomic teammate-membership move and post-commit events. |
| D1-4 | LOW | `shutdown_session.reason` is documented as operator-recorded but is never read, persisted, or emitted. | Open; record it durably or remove the public promise. |
| D2-1 | HIGH | Bundled Grok materialization uses a deterministic shared-temp path and trusts any existing nonempty executable through symlink-following `stat`. Another local user can pre-position attacker bytes that inherit Agent Deck credentials. | Open; move to an owned cache and use no-follow, owner/mode, staging, hash, and atomic-publish checks. |
| D2-2 | HIGH | Codex `AbortSignal` only owns readiness and `turn/start`. After acceptance, timeout, caller abort, or output-limit exit clears local state without a provider-native interrupt, leaving paid work running. | Open; install an exactly-once post-accept abort/interrupt path and drain or recycle before detaching. |
| D2-3 | MEDIUM | The Codex Browser front retains closed-tab target maps and CDP unsubscribe closures until the whole connection disposes, strongly retaining closed windows/webContents during tab churn. | Open; observe/prune tab closure and release per-tab subscriptions immediately. |
| D2-4 | MEDIUM | Console capture marks itself enabled before `Runtime.enable` and `Log.enable` succeed; failure and concurrent calls permanently suppress retry or return before readiness. | Open; share an in-flight promise and commit enabled state only after success. |
| D2-5 | MEDIUM | Codex skill mirroring writes directly to the live directory. Copy/substitution failure can leave a partial existing tree that later sessions trust; substitution errors are swallowed as success. | Open; stage, validate, atomically publish, and remove failed staging/live partials. |
| D2-6 | MEDIUM | The node_repl Browser bootstrap tests `child.killed`, which becomes true when the first signal is sent rather than when the child exits. Further signals are suppressed and no bounded kill fallback exists. | Open; track actual exit and add repeated forwarding plus SIGKILL fallback. |
| D3-1 | HIGH | Issue-resolution creation can throw after the SDK child is live during permission persistence, issue linking, reread, or synchronous notification. Dedupe is then cleared and retry can create an untracked duplicate. | Open; make optional post-create work nonfatal and compensate or return explicit partial success for required link failures. |
| D3-2 | MEDIUM | Transferred diff-review response returns success and removes the renderer card before late delivery resolves. Failure only resets backend state and emits no restoration event. | Open; await delivery or expose/restabilize an explicit pending delivery state. |
| D3-3 | MEDIUM | Both image loaders define absolute paths with `startsWith('/')`, rejecting native Windows drive-letter and UNC paths before canonical authorization. | Open; use platform-aware absolute-path handling with existing realpath/containment checks. |
| D3-4 | MEDIUM | `PermissionsView` has no request generation or cleanup fence. A slower prior session/adapter/manual refresh can overwrite current data, error, and loading state. | Open; make all state writes latest-request-wins. |
| D3-5 | MEDIUM | `CallerArchiveFailed` is emitted and sent by main, but preload and renderer expose no subscriber, so reason and retryability are dropped when system notifications are disabled. | Open; add the typed preload/UI recovery surface or remove the dead IPC promise. |

The findings are tracked in Agent Deck follow-up issues:

- D1: `ca2fb20f-39ac-4f9c-b621-5dbd567840ea`
- D2: `2275955e-7298-4b6e-8c0d-3501e4cafc80`
- D3: `bd43815f-6a64-41a2-8e01-e6bc97b04c3d`

Closure update: all three issues and all fifteen findings were resolved by `PLAN_29`; final
implementation evidence and residual platform boundaries are recorded in `REVIEW_209` and
`CHANGELOG_427`. The open dispositions above describe the audit-time state.

## Compatibility cleanup landed

- Removed zero-caller session, message-repository, continuation-spool, adapter, browser, and
  renderer facades and narrowed current internal contracts.
- Removed the unused raw IPC `teamName` branch, made the only image-thumb callback contract
  required, and deleted a zero-caller shared settings facade while preserving `@shared/types`.
- Removed the retired public Codex `profile` rejection/migration surface from CLI, MCP schemas,
  handler types, descriptions, paired prompt assets, and tests.
- Removed persisted object-form Codex `changeKind` readers and tests; current producers already
  persist canonical strings.
- Removed the zero-production packaged-Codex PATH wrapper and retargeted its useful tests to the
  canonical resolver.

## Validation and evidence

- Focused post-cleanup suite: 11 files and 199 tests passed.
- `pnpm typecheck` passed.
- Full `pnpm test`: 439 files and 3,579 tests passed; one explicit live smoke was skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- D1 supplied a non-mutating in-memory SQLite reproduction of the pending self-message rewrite.
- D2 passed typecheck, shell syntax checks, CJS/MJS syntax checks, and bundled Grok verification.
- D3 passed both TypeScript projects. Its focused Vitest attempt was blocked by the enforced
  read-only sandbox before collection; no result is claimed.
- Lead review re-traced every finding against current source. No live provider/Electron, native
  Linux attack, or native Windows image run was performed.
- The prompt-asset inventory and backup manifest are valid JSON; all eight original backup hashes
  matched. Paired Claude/Codex runtime semantics remained aligned.

## Prompt asset handling

- Active user custom point: runtime prompt assets remain focused on runtime layout/loading and
  paired-resource boundaries, without migrated asset names or repository-maintenance formats.
- Confirmation source: the user said “go on” after the exact eight-file prompt/tool scope was
  presented.
- Pre-edit backups and manifest:
  `.prompt-asset-improver/local/backups/20260731T160100Z/`.
- Restore by copying the backed-up relative paths from that directory over their corresponding
  repository paths. The Grok asset and spawn/session schemas were counterpart checks only and were
  not changed.

## Fixes landed at audit completion

Only the compatibility cleanup was implemented when this audit first completed. The user later
authorized defect remediation; those fixes are recorded separately in `REVIEW_209`.

## Residual risk

- At audit completion, four HIGH, ten MEDIUM, and one LOW defects remained open. They are now fixed;
  `REVIEW_209` supersedes this historical residual count.
- Main, preload, and renderer source changed during compatibility cleanup. The active Electron app
  was not restarted because it owned the collaboration sessions; changes take effect on the next
  normal launch.
- The retained screenshot-name reaper, Grok extension alias, v61 null normalization, and resource
  placeholder behavior are deliberate current safeguards, not unfinished cleanup.

## Follow-ups

1. Completed: all HIGH/MEDIUM/LOW findings were fixed in six isolated batches and fully validated.
2. Remaining coverage recommendation: run native Linux cache-hijack and Windows image-path tests on
   matching hosts, then smoke the three adapters after a normal app restart.
