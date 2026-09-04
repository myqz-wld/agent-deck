---
review_id: 209
reviewed_at: 2026-07-31
baseline_commit: 6c4819855495e75b6a3fedbcce6be12342d4dd45
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Plan, review, changelog, rebucketing, and index maintenance are mechanical records."
---

# REVIEW_209_review-208-defect-remediation: Final integration of all REVIEW_208 findings

## Scope and method

The lead integrated six independent fresh Codex implementation sessions, all using `codex-cli`,
`gpt-5.6-sol`, and `thinking=max`. Three batches fixed the HIGH and cross-layer findings first;
after their combined gate passed, three new batches fixed Browser, skill-mirror, and process
teardown defects. This was ordinary implementation/integration work: neither `simple-review` nor
`deep-review` was invoked.

Every returned diff was inspected against the original producer/consumer and lifecycle evidence.
The issue-resolution batch required and received a correction so an unproven rollback cannot create
a second provider child on retry. The lead then reran focused suites, the full repository suite, and
all release-oriented static gates against the combined dirty tree.

```review-scope
resources/bin/node-repl-browser-bootstrap.cjs
src/main/adapters/codex-cli/app-server/accepted-turn-cancellation.test.ts
src/main/adapters/codex-cli/app-server/accepted-turn-cancellation.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/node-repl-browser-bootstrap.test.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/app-server/turn-output.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/grok-build/__tests__/resolve-grok-binary.test.ts
src/main/adapters/grok-build/resolve-grok-binary.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.cutover.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.handler.test.ts
src/main/agent-deck-mcp/__tests__/hand-off-session.resource-transfer.test.ts
src/main/agent-deck-mcp/__tests__/issue-tools.test.ts
src/main/agent-deck-mcp/__tests__/present-diff.handler.test.ts
src/main/agent-deck-mcp/__tests__/request-plan-review.handler.test.ts
src/main/agent-deck-mcp/__tests__/shutdown.operator-log.test.ts
src/main/agent-deck-mcp/__tests__/spawn-session-output-contract.test.ts
src/main/agent-deck-mcp/__tests__/task-crud.test.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session/resource-transfer-coordinator.ts
src/main/agent-deck-mcp/tools/handlers/shutdown.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/browser-use/__tests__/codex-pipe.test.ts
src/main/browser-use/engine/__tests__/cdp.test.ts
src/main/browser-use/engine/cdp.ts
src/main/browser-use/engine/registry.ts
src/main/browser-use/fronts/codex-pipe.ts
src/main/codex-config/skills-installer.test.ts
src/main/codex-config/skills-installer.ts
src/main/diff-review/service.test.ts
src/main/diff-review/service.ts
src/main/event-bus.ts
src/main/index/__tests__/bootstrap-wiring-observability.test.ts
src/main/ipc/__tests__/adapters-outgoing.test.ts
src/main/ipc/__tests__/issues.test.ts
src/main/ipc/adapters.ts
src/main/ipc/images.ts
src/main/ipc/issues.ts
src/main/platform-paths.test.ts
src/main/platform-paths.ts
src/main/store/__tests__/agent-deck-message-repo.test.ts
src/main/store/__tests__/agent-deck-team-repo.test.ts
src/main/store/agent-deck-message-repo/state-machine.ts
src/main/store/agent-deck-team-repo/index.ts
src/main/store/agent-deck-team-repo/membership-transfer.ts
src/main/store/image-uploads.ts
src/preload/api/events.test.ts
src/preload/api/events.ts
src/renderer/App.archive-failure.test.tsx
src/renderer/App.tsx
src/renderer/components/PermissionsView.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/__tests__/PermissionsView.test.tsx
src/renderer/components/__tests__/ResolveInNewSessionDialog.test.tsx
src/renderer/components/pending-rows/DiffReviewRow.test.tsx
src/shared/types/events.ts
src/shared/types.ts
```

## Finding disposition

| ID | Severity | Final disposition |
|---|---|---|
| D1-1 | HIGH | Fixed: every real MCP caller, including in-process transports, must pass durable non-closed lifecycle authorization; the external sentinel remains narrowly read-only. |
| D1-2 | MEDIUM | Fixed: pending source/successor rows that would collapse to self are cancelled inside endpoint transfer before non-collapsing rows are retargeted. |
| D1-3 | MEDIUM | Fixed: teammate leave/rejoin is one SQLite ownership transaction with idempotence and post-commit events. |
| D1-4 | LOW | Fixed: authorized shutdown attempts record caller, target, and bounded operator reason in structured logs. |
| D2-1 | HIGH | Fixed: bundled Grok uses an app-owned cache, no-follow owner/mode validation, exclusive staging, content validation, atomic publication, and final reopen. |
| D2-2 | HIGH | Fixed: accepted Codex turns share one cancellation owner across signal, live-controller, output-limit, and consumer-detach paths, with bounded drain/recycle. |
| D2-3 | MEDIUM | Fixed: owner-level tab-close notifications and defensive pruning immediately remove target maps and CDP subscriptions. |
| D2-4 | MEDIUM | Fixed: console enable is one shared promise, commits only after both domains succeed, and retries safely after failure or detach. |
| D2-5 | MEDIUM | Fixed: Codex skills are hashed after substitution, prepared in unique sibling staging, validated, published with rollback, and revalidated before every session use. |
| D2-6 | MEDIUM | Fixed: node_repl forwards repeated termination signals until actual child exit and enforces a bounded SIGKILL/wrapper-exit fallback. |
| D3-1 | HIGH | Fixed: optional post-create work is nonfatal, required link failures prove provider and durable close, and incomplete rollback permanently fences retry for that process/dialog while exposing the child id. |
| D3-2 | MEDIUM | Fixed: transferred diff decisions await late delivery; failure restores pending and rejects IPC so the renderer keeps the action card. |
| D3-3 | MEDIUM | Fixed: drive-letter and UNC absolute paths reach unchanged canonical realpath/containment authorization on Windows. |
| D3-4 | MEDIUM | Fixed: one monotonic generation fences success, error, and loading writes across prop changes and manual refreshes. |
| D3-5 | MEDIUM | Fixed: the typed archive-failure payload crosses preload and renders a bounded dismiss/retry surface only for retryable failure kinds. |

No confirmed finding remains open.

## Validation and evidence

- Lead focused integration passed: state/handoff 5 files / 94 tests; Codex/Grok runtime 14 files /
  114 tests; IPC/renderer 13 files / 134 tests; Browser-use 9 files / 88 tests; skill mirror
  12 tests; node_repl 8 tests.
- Full Electron-ABI suite: 446 files passed and 1 intentional live smoke skipped; 3,656 tests
  passed and 1 skipped.
- Node and renderer TypeScript checks passed; the production main, preload, and renderer build
  passed.
- Logger guard, tracked/untracked whitespace validation, Shell/CJS/MJS syntax checks, and bundled
  Grok 0.2.114 verification passed.
- All changed production files remain within the repository's 500-line guardrail.

## Residual risk

- POSIX attack tests ran on macOS, not a shared Linux host. Windows path policy and containment have
  deterministic `win32` coverage but no native Windows filesystem run.
- No live Codex/Grok provider, native Browser plugin churn, or restarted Electron application smoke
  was performed. Main/preload changes load on the next normal launch.
- An issue-resolution rollback that cannot prove provider and durable closure is intentionally
  blocked for the process lifetime. Manual cleanup therefore requires a restart before retry; this
  avoids duplicate live children when no stronger cleanup proof exists.

## Follow-up

- Run native Linux and Windows integration coverage in matching CI/hosts when available.
- On the next normal launch, smoke one handoff, one Codex cancellation, Browser tab churn, archive
  retry UI, and Windows image history where the matching platform is available.
