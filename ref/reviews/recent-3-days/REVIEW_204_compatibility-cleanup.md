---
review_id: 204
reviewed_at: 2026-07-31
baseline_commit: f5e8bc5bbd02090d8817c5acac98c34c60d462a5
expired: false
---

# REVIEW_204_compatibility-cleanup: Current-only compatibility cutover and codebase slimming

## Scope and policy

Three independent read-only sessions audited UI/internal boundaries, session/store/teams/MCP, and
adapters/tooling/assets. After receiving their evidence, the user explicitly authorized removing
all four deferred external-compatibility groups because Agent Deck has no external users and is
still in testing. The implementation therefore treats the repository as a current-version-only new
project while preserving present-day resilience and safety paths.

The lead integrated the cleanup, ran three post-change read-only reviews, corrected every valid
finding, and used the prompt-asset workflow for MCP descriptions and paired bundled instructions.

```review-scope
package.json
resources/bin/agent-deck
resources/bin/agent-deck.cmd
resources/bin/node-repl-browser-bootstrap.cjs
resources/bin/node-repl-browser-process-compat.cjs
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
resources/grok-config/GROK_AGENTS.md
src/main/adapters/provider-usage.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/node-repl-browser-bootstrap.ts
src/main/adapters/codex-cli/app-server/protocol.ts
src/main/adapters/codex-cli/app-server/translate-collab.ts
src/main/adapters/codex-cli/app-server/translate.ts
src/main/adapters/codex-cli/sdk-bridge/client-registry.ts
src/main/adapters/codex-cli/sdk-bridge/codex-binary.ts
src/main/adapters/grok-build/history-usage.ts
src/main/agent-deck-mcp/tools/handlers/enter-worktree.ts
src/main/agent-deck-mcp/tools/handlers/exit-worktree.ts
src/main/agent-deck-mcp/tools/handlers/request-plan-review.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/lifecycle.ts
src/main/cli.ts
src/main/session/continuation-context/message-classifier.ts
src/main/session/summarizer/index.ts
src/main/session/worktree-transition/recovery.ts
src/main/store/db.ts
src/main/store/schema.sql
src/main/store/schema.ts
src/main/store/settings-store.ts
src/main/store/storage-maintenance/file-snapshots.ts
src/main/store/storage-maintenance/maintenance-engine.ts
src/main/store/summary-repo.ts
src/main/store/message-delivery-state.ts
src/main/store/worktree-transition-repo.ts
src/preload/index.ts
src/shared/wire-prefix.ts
src/shared/types/session.ts
src/shared/types/settings/app-settings.ts
src/shared/types/summary.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The aggressive pass removed the whole node_repl bridge, but a recent real ChatGPT node_repl reproduction proves the frozen trusted `process` facade still blocks the current Browser client. | Restored only the narrow Browser process preload and a slim `NODE_OPTIONS --require` launcher/config wrapper. The old sandbox-policy translation, legacy fixture, and protocol relay remain deleted. |
| MEDIUM | Historical migrations, offline migration runners, staged FTS/file-snapshot transitions, settings transforms, summary/history fallbacks, and marker-only worktree adoption dominated current code despite the test-stage reset policy. | Replaced them with a single v60 schema baseline and current-only repositories/contracts. Non-v60 and partial databases are rejected without mutation; v60 databases must match the exact current schema fingerprint. |
| MEDIUM | A concurrent repeat of `enter_worktree` during `phase="creating"` could receive formal asynchronous success before `git worktree add` completed or failed. | Only `enter_waiting_tool_result` is now idempotent success; `creating` returns a retryable error tied to the original invocation. Tool text and regression coverage were updated. |
| MEDIUM | Codex quota parsing was narrowed to optional `rateLimitsByLimitId`, although Codex 0.146 requires singular `rateLimits` and makes the map optional. | Restored map-preferred/singular-fallback parsing and added a `map=null` current-protocol test. |
| MEDIUM | Codex normalized collaboration events still matched `collabAgentToolCall`, while 0.146 emits `collabToolCall`; native raw tool names had also been over-narrowed. | Switched normalized translation to the current item/field shape and retained both current provider-native and Agent Deck raw collaboration names with focused fixtures. |
| MEDIUM | Paired Codex/Claude instructions still documented a removed `present_plan` timeout option and timeout result. | Removed the stale timeout contract from both assets while retaining `present_diff` timeout behavior. |
| LOW | Three spawn test helpers could silently fall back from structured content to old text success payloads. | Success paths now require empty text content plus `structuredContent`; text parsing remains explicit only for error results. |
| LOW | Grok history usage still read a removed `thoughtTokens` extension field through an index signature. | Removed the residual read while retaining the separate current ACP and xAI reasoning-token boundaries. |

## Cleanup result

- Replaced 59 historical SQLite migrations with a 735-line current schema and deleted migration/offline-repair tests and runners.
- Removed old settings/value normalization, continuation wrappers, summary cursors, snapshot staging, message-row clauses, worktree markers/adoption, CLI aliases, non-isolated preload assignment, optional hook adapter calls, old MCP text-success duplication, and protocol aliases.
- Removed unreachable event-search maintenance, unused repository methods/factories, schema capability probes, fixture-only row shapes, ignored options, manual benchmark runners, and stale refactor narratives.
- Kept current renderer/session races, Electron window/send guards, corruption/concurrency recovery, generic cwd recovery, shell PATH discovery, provider/OS variability, Browser background input, cross-hook deduplication, Codex quota variants, and the Browser/node_repl preload.
- Implementation/test/resource working-tree diff plus its one-line review-index update: 409 files,
  3,007 inserted lines and 23,733 deleted lines, net **20,726 lines removed**. The review record
  itself is excluded from this count.

## Intentional breaking policy

- Only database schema v60 is supported. Existing non-v60 test databases must be deleted; startup rejection does not mutate them.
- Historical settings keys/values, persisted wrapper/wire shapes, old summary/checkpoint/snapshot rows, legacy worktree markers, CLI aliases, preload fallbacks, and old MCP/provider payload aliases are unsupported.
- Current documented provider variants and runtime recovery are not considered historical compatibility and remain supported.
- The active development Electron process was not restarted because it owns live sessions; main/preload changes take effect on the next normal launch.

## Validation and evidence

- `pnpm typecheck` passed.
- `pnpm test` passed under the Electron ABI: 438 test files and 3,615 tests passed; one explicit live smoke was skipped.
- `pnpm test:fts5` passed 21 tests, including fresh/current/old/partial database behavior and current FTS search.
- `pnpm build` passed.
- `pnpm logger:check` passed.
- `git diff --check` passed.
- Three post-change reviewers covered store/schema, MCP/worktree/prompt, and adapters/runtime. All reported blockers were resolved and their focused suites passed.
- Prompt inventory hashes were refreshed after the final edits. The manifest-backed pre-edit backup at `.prompt-asset-improver/local/backups/20260731T112032Z/` verified 5/5 original hashes and remains the restore source.
