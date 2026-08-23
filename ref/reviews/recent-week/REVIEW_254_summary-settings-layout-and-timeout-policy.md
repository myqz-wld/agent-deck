---
review_id: 254
reviewed_at: 2026-08-18
baseline_commit: 76e2b6471db034367d9d1686659c2545fbb0871f
expired: false
---

# REVIEW_254_summary-settings-layout-and-timeout-policy: Generator settings consistency

## Scope

The user reported inconsistent ordering between continuation-context and periodic-summary settings,
specifically the position of maximum concurrency, and requested removal of the exposed per-summary
timeout. The review traced the setting from renderer through AppSettings, persistence projections,
remote node contracts, Desktop/Server Core provider hosts, and Claude/Codex/Grok runners.

```review-scope
src/contracts/node-configuration.test.ts
src/contracts/node-configuration.ts
src/hosts/provider-state/local-worker-desktop-state.ts
src/hosts/server-core/node-configuration-runtime.test.ts
src/hosts/server-core/node-configuration-runtime.ts
src/hosts/server-core/provider-claude-host.ts
src/hosts/server-core/provider-codex-host.ts
src/hosts/server-core/provider-grok-host.ts
src/hosts/server-core/provider-settings.test.ts
src/hosts/server-core/provider-settings.ts
src/main/adapters/codex-cli/aggregate-host-core.test.ts
src/main/adapters/codex-cli/summarizer-runner-core.test.ts
src/main/adapters/codex-cli/summarizer-runner-core.ts
src/main/adapters/codex-cli/summarizer-runner-host.test.ts
src/main/adapters/codex-cli/summarizer-runner-host.ts
src/main/adapters/codex-cli/summarizer-runner.ts
src/main/adapters/grok-build/__tests__/summarizer-runner.test.ts
src/main/adapters/grok-build/adapter-host.ts
src/main/adapters/grok-build/aggregate-host-core.test.ts
src/main/adapters/grok-build/summarizer-runner-core.test.ts
src/main/adapters/grok-build/summarizer-runner-core.ts
src/main/adapters/grok-build/summarizer-runner-host.test.ts
src/main/adapters/grok-build/summarizer-runner-host.ts
src/main/ipc/settings.ts
src/main/remote-host/service-node-configuration.test.ts
src/main/session/__tests__/summarizer-runner.test.ts
src/main/session/oneshot-llm/race-with-timeout.ts
src/main/session/summarizer/__tests__/llm-runners-defaults.test.ts
src/main/session/summarizer/claude-runner-core.ts
src/main/session/summarizer/llm-runners.ts
src/main/store/__tests__/settings-store.test.ts
src/renderer/components/SettingsDialog.remote.test.tsx
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/__tests__/ContinuationContextSection.test.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/shared/types/settings/app-settings.ts
src/shared/types/settings/defaults.ts
src/shared/types/summary.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Continuation placed model before concurrency while Summary placed concurrency before model, so two related generator panels had no stable scan order. | Adopt one ordering rule and move Summary’s model card ahead of maximum concurrency; assert the complete field sequence in both sections. |
| MEDIUM | `summaryTimeoutMs` was a user-editable setting, could disable timeout with zero, crossed Local Worker/Server Core configuration boundaries, and added host plumbing to every provider despite being scheduler protection policy. | Remove the field from all public/persisted projections and host ports. Use the fixed five-minute `PERIODIC_SUMMARY_TIMEOUT_MS` directly in Claude, Codex, and Grok runner cores. |

## Preserved behavior

- Summary enablement, minute/event triggers, maximum concurrency, model/provider/thinking selection,
  error diagnostics, runtime precedence, and output cleanup are unchanged.
- Continuation auto-refresh, model selection, concurrency, raw-retention control, and five-minute
  checkpoint budgets are unchanged.
- Oneshot timeout cancellation and provider-specific timeout error identifiers remain intact; only
  ownership of the numeric deadline changed.
- Local and remote panels retain identical field slots and read-only behavior.

## Validation

- Focused suite: 18 files / 68 tests passed, covering both UI orders, absence of the timeout input,
  store filtering, exact node/provider schemas, Local Worker projection, and all provider runners.
- `pnpm typecheck`: architecture boundaries plus Node/Web TypeScript passed.
- `pnpm test`: 971 files / 6,138 tests passed; 2 files / 3 explicit tests skipped.
- `pnpm build`: main, preload, renderer, and build-info passed.
- `pnpm check:deployment` and `pnpm logger:check` passed.
- Production-wide search: zero `summaryTimeoutMs`, `readSummaryTimeoutMs`, or “单次总结超时” hits.
- `git diff --check`, review-scope coverage, index parity, and changed non-test source file size checks
  passed.

## Residual risk

- Five minutes is intentionally application policy rather than a user preference. Changing it later
  requires a code/test change, preventing Desktop/Server Core or provider-specific drift.
- Existing settings files may still contain an ignored extra JSON key; `settingsStore.getAll()`
  projects only current defaults and has direct coverage proving the removed key cannot re-enter the
  application contract.
- No remaining follow-up is required.
