---
review_id: 153
reviewed_at: 2026-07-12
baseline_commit: 4ca882199ff04cb7e9cca761a8566488c7ac6f5d
expired: false
skipped_expired: []
---

# REVIEW_153_storage-maintenance-worker-provider-compaction: Dedicated maintenance worker and provider compact runtime

## Scope and method

This review covered the complete issue-resolution worktree: the persistent live storage-maintenance
worker and WAL lease, cross-connection event/snapshot safety, lifecycle integration, Codex thinking
level migration, summary diagnostics, hardened Codex summary/checkpoint execution, structured-output
compatibility, provider dependency updates, and paired runtime/MCP prompt assets.

The user requested one standalone `gpt-5.6-sol` reviewer at `xhigh`. That reviewer inspected the
final worktree, ran focused tests and a real non-empty Codex checkpoint/persistence smoke, and returned
PASS with no CRITICAL/HIGH/MEDIUM findings. One LOW stale-comment finding was fixed after the verdict;
it changed documentation only and aligned the comments with the reviewed runtime.

```review-scope
README.md
package.json
pnpm-lock.yaml
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
src/main/adapters/__tests__/session-model-options.test.ts
src/main/adapters/codex-cli/__tests__/codex-model-passthrough.test.ts
src/main/adapters/codex-cli/app-server/notification-helpers.test.ts
src/main/adapters/codex-cli/app-server/notification-helpers.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/codex-instance-pool.ts
src/main/adapters/codex-cli/sdk-bridge/create-session/_deps.ts
src/main/adapters/codex-cli/summarizer-runner.ts
src/main/adapters/types/create-session-opts.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.schema.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/tools/schemas/retired.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/codex-config/__tests__/toml-writer.test.ts
src/main/codex-config/custom-agents.test.ts
src/main/index/_deps.ts
src/main/index/bootstrap-infra.ts
src/main/index/lifecycle-hooks.ts
src/main/ipc/__tests__/settings-continuation.test.ts
src/main/ipc/settings.ts
src/main/session/__tests__/summarizer-revision-cursor.test.ts
src/main/session/continuation-context/__tests__/checkpoint-schema.test.ts
src/main/session/continuation-context/__tests__/codex-isolation.test.ts
src/main/session/continuation-context/__tests__/codex-live-smoke.test.ts
src/main/session/continuation-context/__tests__/service.test.ts
src/main/session/continuation-context/checkpoint-fold.ts
src/main/session/continuation-context/checkpoint-generator.ts
src/main/session/continuation-context/checkpoint-schema.ts
src/main/session/continuation-context/codex-isolation.ts
src/main/session/continuation-context/runtime.ts
src/main/session/continuation-context/types.ts
src/main/session/oneshot-llm/codex-runner.ts
src/main/session/summarizer/index.ts
src/main/store/__tests__/settings-store-continuation.test.ts
src/main/store/settings-store.ts
src/main/store/storage-maintenance/event-search-concurrency.test.ts
src/main/store/storage-maintenance/event-search.ts
src/main/store/storage-maintenance/file-snapshots.concurrency.test.ts
src/main/store/storage-maintenance/file-snapshots.ts
src/main/store/storage-maintenance/main-checkpoint-lease.ts
src/main/store/storage-maintenance/maintenance-engine.ts
src/main/store/storage-maintenance/maintenance-scheduler.test.ts
src/main/store/storage-maintenance/maintenance-worker-contract.ts
src/main/store/storage-maintenance/maintenance-worker-engine.integration.test.ts
src/main/store/storage-maintenance/maintenance-worker.ts
src/main/store/storage-maintenance/scheduler.ts
src/main/store/storage-maintenance/storage-maintenance.test.ts
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/__tests__/SessionModelFields.test.tsx
src/renderer/components/settings/ProviderModelThinkingFields.tsx
src/renderer/components/settings/sections/ContinuationContextSection.tsx
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/__tests__/ContinuationContextSection.test.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/shared/__tests__/session-metadata.test.ts
src/shared/session-metadata.ts
src/shared/types/session.ts
src/shared/types/settings/app-settings.ts
```

## Verdict

**PASS.** Final finding distribution:

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 0
- LOW: 1 fixed (stale comments incorrectly described checkpoint generation as fail-closed)
- INFO: production-copy tail rerun remains an accepted evidence limitation

## Key conclusions

- The worker split is real: main schedules only; hashing, compression, maintenance writes, and
  PASSIVE checkpoints execute on the persistent worker connection.
- WAL lease acquisition/restoration, watchdog retirement, independently correlated close, retiring
  generation boundaries, restart eligibility, and durable cursor continuation are covered by focused
  state-machine and file-backed tests.
- Cross-connection event/snapshot guards preserve ingress atomicity; live GC takes the writer lock;
  destructive operations remain behind the clean shutdown drain gate.
- Codex checkpoint generation no longer fails solely because built-in registry attestation is
  unavailable. The approved outer hardening is applied, and generated output must pass the existing
  provider-neutral evidence/carry-forward/revision/CAS gates before persistence.
- Real Codex 0.144.1 evidence proves the runtime emits a new non-empty checkpoint rather than silently
  using raw fallback. Failure paths still retain the last valid checkpoint and immutable history tail.
- Codex `minimal` is closed on all new input surfaces while legacy settings/history remain safe.
- Claude effort values were not conflated with the SDK's separate `ultracode` orchestration flag.

## Validation evidence

- `pnpm test`: 268 files passed, 1 opt-in file skipped; 2,531 tests passed, 1 skipped.
- Reviewer focused gate: 14 files / 99 tests passed.
- Real empty-evidence Codex live smoke: 1/1 passed in 32.8 seconds.
- Reviewer non-empty Codex live smoke: 1/1 passed in 37.95 seconds, three validated facts.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check`: passed.
- Built-worker smoke: `quick_check=ok`, FK violations 0, heartbeat max drift 0.677 ms.
- Continuous ingress: main-write p95 1.631 ms, p99/max 4.216 ms; heartbeat max 2.818 ms;
  maximum WAL 7,992,832 bytes; quick/FK checks passed.
- Changed production LOC guard: scheduler 500, file-snapshots 484, checkpoint runtime 338.

## Residual limitation

No disposable 1.9 GiB production-shape copy was rerun after the final integration. The prior
production-copy measurements motivated the issue; the final file-backed/synthetic gates establish
correctness and a materially bounded responsiveness/WAL result without claiming that missing tail run.

## Related records

- [CHANGELOG_362](../../changelogs/recent-3-days/CHANGELOG_362_storage-maintenance-worker-provider-compaction.md)
- [PLAN_7](../../plans/recent-3-days/PLAN_7_storage-maintenance-worker-provider-compaction.md)
- Reproduction harnesses:
  [built-worker integrity](../../plans/recent-3-days/PLAN_7_storage-maintenance-worker-provider-compaction/spike-reports/verify-maintenance-worker-built.mjs) and
  [continuous ingress/WAL](../../plans/recent-3-days/PLAN_7_storage-maintenance-worker-provider-compaction/spike-reports/benchmark-maintenance-worker-built.mjs)
