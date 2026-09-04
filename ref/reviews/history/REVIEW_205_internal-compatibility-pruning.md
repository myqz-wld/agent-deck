---
review_id: 205
reviewed_at: 2026-07-31
baseline_commit: 840debb4231ee7bb8916cebbc2c3cbe66bbcdb46
expired: false
---

# REVIEW_205_internal-compatibility-pruning: Second-pass internal compatibility pruning

## Scope and policy

After the current-only cutover in REVIEW_204, three independent read-only sessions audited the
remaining store/session/team, MCP/UI/shared, and adapters/assets/config surfaces. The user had
already confirmed that Agent Deck has no external users and remains in testing, so this pass
removed only repository-internal compatibility seams, unreachable feature scaffolding, dead
exports, fixture-shaped production options, and stale comments. Present-day authentication,
provider variability, crash recovery, corruption containment, and worktree safety remain intact.

Three scope-matched reviewers then inspected the actual integrated diff and returned NO_BLOCKER.

```review-scope
.gitignore
package.json
resources/README.md
src/main/__tests__/bundled-assets-multi-root.test.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts
src/main/adapters/claude-code/sdk-bridge/recoverer.ts
src/main/adapters/claude-code/sdk-bridge/recoverer/jsonl-discovery.ts
src/main/adapters/claude-code/sdk-bridge/restart-controller-types.ts
src/main/adapters/codex-cli/app-server/notification-helpers.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/recoverer-jsonl-exists.test.ts
src/main/adapters/codex-cli/sdk-bridge/codex-jsonl-fallback.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/jsonl-discovery.ts
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/turn-queue-types.ts
src/main/agent-deck-mcp/__tests__/browser-tools.test.ts
src/main/agent-deck-mcp/__tests__/enter-exit-worktree.handler.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-worktree-preflight.test.ts
src/main/agent-deck-mcp/__tests__/helpers.deny-external.test.ts
src/main/agent-deck-mcp/__tests__/issue-tools.test.ts
src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts
src/main/agent-deck-mcp/__tests__/spawn-session-output-contract.test.ts
src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts
src/main/agent-deck-mcp/__tests__/task-events.test.ts
src/main/agent-deck-mcp/__tests__/task-external-caller.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/mcp-session-token-map.ts
src/main/agent-deck-mcp/server.ts
src/main/agent-deck-mcp/tools/handlers/browser/shared.ts
src/main/agent-deck-mcp/tools/handlers/task-create.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas.ts
src/main/agent-deck-mcp/tools/schemas/browser.ts
src/main/agent-deck-mcp/tools/schemas/issues.ts
src/main/agent-deck-mcp/tools/schemas/lifecycle.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/agent-deck-mcp/tools/schemas/shared.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/agent-deck-mcp/tools/schemas/tasks.ts
src/main/agent-deck-mcp/transport-http.ts
src/main/agent-deck-mcp/transport-stdio.ts
src/main/agent-deck-mcp/types.ts
src/main/bundled-assets.ts
src/main/hook-server/server.ts
src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts
src/main/index/__tests__/checkpoint-shutdown-entry.test.ts
src/main/index/bootstrap-infra.ts
src/main/index/lifecycle-hooks.ts
src/main/ipc/_image-constants.ts
src/main/ipc/assets.ts
src/main/session/continuation-context/__tests__/checkpoint-schema.test.ts
src/main/session/continuation-context/__tests__/codex-isolation.test.ts
src/main/session/continuation-context/checkpoint-background-worker.ts
src/main/session/continuation-context/checkpoint-schema.ts
src/main/session/continuation-context/codex-isolation.ts
src/main/session/continuation-context/initial-turn.ts
src/main/session/continuation-context/raw-user-tail.ts
src/main/session/oneshot-llm/__tests__/grok-runner.test.ts
src/main/session/oneshot-llm/grok-runner.ts
src/main/session/worktree-transition/__tests__/coordinator-observe.test.ts
src/main/session/worktree-transition/__tests__/git-cleanup.test.ts
src/main/session/worktree-transition/__tests__/recovery.test.ts
src/main/session/worktree-transition/__tests__/resume-recovery.test.ts
src/main/session/worktree-transition/types.ts
src/main/store/__tests__/agent-deck-team-repo.test.ts
src/main/store/__tests__/db-schema.test.ts
src/main/store/__tests__/session-event-revision-rename.test.ts
src/main/store/__tests__/token-usage-lifecycle-scheduler.test.ts
src/main/store/agent-deck-team-repo/types.ts
src/main/store/continuation-checkpoint-repo.ts
src/main/store/message-delivery-state.ts
src/main/store/schema.sql
src/main/store/schema.ts
src/main/store/session-handoff-alias-repo.ts
src/main/store/session-repo/__tests__/agent-runtime-profile.test.ts
src/main/store/session-repo/__tests__/grok-sandbox.test.ts
src/main/store/session-repo/__tests__/pin-lifecycle.test.ts
src/main/store/session-repo/core-crud.ts
src/main/store/session-repo/index.ts
src/main/store/session-repo/rename.ts
src/main/store/storage-maintenance/file-snapshots.ts
src/main/store/storage-maintenance/maintenance-engine.ts
src/main/store/token-usage-lifecycle-scheduler.ts
src/main/store/token-usage-repo.ts
src/main/store/worktree-transition-repo.ts
src/main/store/worktree-transition-row.ts
src/main/teams/team-lifecycle-scheduler.ts
src/main/window/_deps.ts
src/renderer/components/IssueDetail.tsx
src/renderer/components/SessionDetail/composer-sdk/SandboxSelects.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionMetadataChips.tsx
src/renderer/components/TeamDetail/helpers.ts
src/renderer/components/activity-feed/rows/message-viewer.test.tsx
src/renderer/components/activity-feed/viewers/content-reference.ts
src/renderer/components/activity-feed/viewers/message-content.ts
src/renderer/components/expandable-content/__tests__/ExpandableContent.test.tsx
src/renderer/components/expandable-content/identity.ts
src/renderer/components/expandable-content/index.ts
src/renderer/components/expandable-content/types.ts
src/renderer/components/icons/actions.tsx
src/renderer/components/icons/content.tsx
src/renderer/components/icons/people.tsx
src/renderer/components/issue-detail/IssueEvidence.tsx
src/renderer/components/settings/sections/AgentDeckMcpSection.tsx
src/renderer/lib/platform.ts
src/shared/__tests__/session-metadata.test.ts
src/shared/codex-agent-toml.ts
src/shared/constants/read-only-tools.ts
src/shared/ipc-channels.ts
src/shared/session-metadata.ts
src/shared/types.ts
src/shared/types/assets.ts
src/shared/types/attachment.ts
src/shared/types/issue.ts
src/shared/types/settings/app-settings.ts
src/shared/types/settings/defaults.ts
src/shared/types/team.ts
vitest-setup.ts
vitest.config.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Public MCP schemas exposed `callerSessionId`, but production always derived identity from authenticated transport context while tests simulated an argument override that did not exist. | Removed the field from all tool schemas and test inputs. In-process providers and HTTP auth are now the only identity sources; global HTTP tokens still map to the read-only external sentinel. |
| MEDIUM | The stdio MCP slice had no CLI entry point or production importer, yet retained settings, UI copy, transport types, placeholder server code, and spoofing tests. | Deleted the vertical slice and narrowed the live contract to in-process plus HTTP without weakening global-token denial or per-session-token authentication. |
| MEDIUM | Session rename could merge a temporary source into an already-existing canonical target and overwrite selected target state. Current callers only rename a temporary application id to the first provider id. | Replaced destructive merge behavior with an atomic collision error and kept the missing-target insert, FK transfers, revision boundary, lineage, tasks, issues, messages, and team ownership moves. |
| LOW | Current-schema repositories retained empty `app_meta`, an ignored worktree transition format column, a missing-table capability probe, unused singleton registries, and whole-result alias readers. | Removed the residue, bumped the exact current schema baseline to v61, and kept schema fingerprint/TOCTOU validation and current recovery state machines. |
| LOW | An expandable-content resolver/reference foundation and many leaf exports, aliases, props, icons, selectors, and comments had no production consumer. | Deleted the orphan implementation and tests while retaining the active message/diagnostic expandable payloads and all renderer behavior. |
| LOW | Recoverer facade re-exports, Grok fixture process options, dead adapter helpers, and duplicated packaged resources widened internal APIs or payload size. | Retargeted imports to owning modules, mocked launch dependencies in tests, enforced bundled Codex TOML filename/name identity, and kept only the runtime icon in `app.asar`; external resource directories remain exact `extraResources` copies. |

## Cleanup result

- Removed the public phantom identity field from 33 MCP schemas and deleted the unreachable stdio
  transport, settings row, types, and compatibility-only tests.
- Reduced session rename to the live temp-to-canonical invariant and removed unbounded/unused
  repository APIs, schema probes, registries, test-only production options, and zero-consumer exports.
- Deleted the unused content-reference implementation and pruned inactive expandable payload types,
  dead renderer subscriptions/props/helpers/icons, and obsolete TypeScript aliases.
- Removed recoverer facade compatibility re-exports and enforced direct module ownership.
- Eliminated roughly 312 KiB of duplicated runtime resources from `app.asar`; the packaged
  `bin`, Claude/Codex/Grok config, and sound trees remain byte-for-byte directory matches.
- Before this review record and index row, the diff covered 125 files with 383 insertions and
  3,132 deletions: net **2,749 lines removed**.

## Validation and evidence

- `pnpm typecheck` passed after the final edits.
- `pnpm test` passed under the Electron ABI: 438 test files and 3,553 tests passed; one explicit
  live smoke remained skipped.
- `pnpm test:fts5` passed all 21 current-schema/search tests.
- Final focused MCP/auth/bundled-asset validation passed 105 tests.
- `pnpm build` and `pnpm logger:check` passed.
- `electron-builder --dir` produced the macOS arm64 application. Signing was intentionally skipped
  because no local signing identity is installed.
- Packaged `app.asar` contains only `resources/icon.png` under the resource tree; all five
  `extraResources` directories matched their source directories with `diff -qr`.
- `git diff --check` passed.
- Store/session, MCP/UI, and adapters/assets reviewers independently returned `NO_BLOCKER`.

## Residual risk

- Schema v61 is intentionally the only supported database baseline; v60 test databases are rejected
  without mutation and must be recreated.
- `src/main/adapters/claude-code/sdk-bridge/index.ts` (506 lines) and
  `src/main/adapters/codex-cli/sdk-bridge/index.ts` (501 lines) remain just over the 500-line
  guardrail. This pass changed only their import ownership; splitting stateful adapter facades here
  would expand risk beyond compatibility cleanup. Revisit when either facade gains logic or is next
  changed for adapter architecture.
- The active development Electron process was not restarted; main/preload changes take effect on the
  next normal launch.

## Follow-ups

None required for this cleanup.
