---
review_id: 322
reviewed_at: 2026-10-14
baseline_commit: cfa43ce9dd64450859f48346d9ff069b2a3006b3
expired: false
---

# MCP handoff and control repairs

## Scope and method

User-approved implementation of the recommended discovery policy, all three verified defects in REVIEW_321, contract/instruction cleanup, and the later diff-focus request. Lead inspection and deterministic regression tests were used; no paired review was requested or run. The earlier audit's expiry-helper failure is recorded in REVIEW_321; no prior coverage exempted the changed contracts.

```review-scope
AGENTS.md
CLAUDE.md
README.md
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
resources/grok-config/GROK_AGENTS.md
src/gateways/im/conversation-prompt.ts
src/main/agent-deck-mcp/session-directory.ts
src/main/agent-deck-mcp/session-shutdown-authority.ts
src/main/agent-deck-mcp/session-tool-descriptions.ts
src/main/agent-deck-mcp/tools/handlers/list.ts
src/main/agent-deck-mcp/tools/handlers/get.ts
src/main/agent-deck-mcp/tools/handlers/shutdown.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas/session.ts
src/main/agent-deck-mcp/types.ts
src/main/agent-deck-mcp/__tests__/session-directory.test.ts
src/main/agent-deck-mcp/__tests__/session-shutdown-authority.test.ts
src/main/agent-deck-mcp/__tests__/shutdown.confirmation.test.ts
src/main/agent-deck-mcp/__tests__/shutdown.operator-log.test.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/__tests__/worktree-contract-drift.test.ts
src/main/codex-config/__tests__/bundled-reviewer-runtime.test.ts
src/main/session/hand-off/ownership.ts
src/main/session/hand-off/ownership-lineage.ts
src/hosts/server-core/mcp-session-collaboration.ts
src/hosts/server-core/mcp-session-collaboration.test.ts
src/hosts/server-core/mcp-session-visibility.ts
src/hosts/server-core/mcp-session-port.ts
src/hosts/server-core/mcp-session-tools.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/mcp-server.ts
src/hosts/server-core/mcp-server.test.ts
src/hosts/server-core/mcp-server.test-fixture.ts
src/hosts/server-core/mcp-spawn-tools.ts
src/hosts/server-core/mcp-handoff-tools.ts
src/hosts/server-core/mcp-worktree-tools.ts
src/hosts/server-core/mcp-worktree-schema.ts
src/hosts/server-core/mcp-presentation-tools.ts
src/hosts/server-core/mcp-feishu-work-sessions.ts
src/hosts/server-core/mcp-feishu-work-sessions.test.ts
src/renderer/components/diff/renderers/MonacoDiffView.tsx
src/renderer/components/diff/renderers/MonacoDiffView.readiness.test.tsx
src/renderer/components/diff/renderers/MonacoDiffView.lifecycle.test.tsx
```

## Findings and fixes landed

1. **F1, MEDIUM, fixed:** Core previously walked only forward handoff aliases and lost a predecessor's teamless child. It now uses the same bounded predecessor-lineage reader as Local. The reader was extracted from the Electron-owned facade so the Core composition remains Node-safe. A regression covers default metadata, explicit related discovery, and child event reads after handoff.
2. **F2, MEDIUM, fixed:** Core now resolves committed target successors before target checks and canonicalizes both historical DM endpoints for reply validation. A delivered pre-handoff wire anchor can be answered through its old sender ID, while wrong-pair replies still reject.
3. **F3, MEDIUM, fixed:** Local/Core share bounded live/history iterators and merge them by activity time, with filtering before output pagination. Regressions use 650 history rows under the real 500-row query cap and 900 mixed rows with sparse relationship/parent filters. They prove correct later pages and `hasMore`.
4. **Control policy implemented:** Directory discovery grants no destructive authority. Managed descendants bypass the additional question; peers and ancestors do not. Unrelated live targets require a host-owned question whose answer yields a one-use closure, never a model-provided boolean. Tests cover wrong responder, rejection, blank/free-text answers, timeout, abort, identity changes, caller/target handoff, and repeated consumption. Actual Pending service integration confirms the target remains open until the owner chooses the explicit close option.
5. **Contract drift corrected:** Shared list/get/event/message/shutdown descriptions are used by both hosts. The user's final discovery refinement defaults to related open sessions and requires explicit `scope: all` for unrelated metadata; filters cannot expand scope. Core's spawn result describes and validates a relative `cwd`; Core diff timeout omission is explicitly indefinite; handoff/worktree descriptions contain the transition rules removed from Markdown. Task-list external empty scope and page-size semantics are explicit. Feishu directory prompts distinguish its owner directory from generic discovery.
6. **Prompt duplication reduced:** Runtime assets defer tool contracts to live metadata and retain cross-tool waiting, result validation, native-agent distinctions, Browser routing, host safety and recovery workflow. Root AGENTS references the shared repository entrypoint without copying its host-safety section.
7. **Diff focus added:** First-change navigation runs after computed-diff layout, once per model. Readiness/lifecycle tests verify no repeat jump and no stale-model callback revealing its replacement.

## Validation / evidence

`pnpm build` passed for the initial delivery, before the final default-scope refinement. Task-focused validation passed 180 tests across 15 files, including targeted reruns after the management-edge check; a documentation-only cleanup passed 15 contract tests. The scope refinement passed 130 tests across six files, covering both hosts, open lifecycle defaults, explicit all discovery, parent filters, external callers, and the published MCP surfaces. Architecture and Core Node-boundary checks passed and confirm that the extracted ownership reader introduces no Electron dependency into Core.

At commit time, an exported staged tree passed `pnpm typecheck` and the complete test suite: **7,167 passed, 6 skipped**, with 1,146 passing files and 3 skipped files. This snapshot includes only the scoped delivery and shares the existing dependency installation. It verifies that the commit does not depend on concurrent edits.

An earlier shared-workspace `pnpm typecheck` was blocked by four concurrent `permissionMode` narrowing errors in:

- `src/main/agent-deck-mcp/__tests__/hand-off-session.preflight.test.ts`
- `src/main/agent-deck-mcp/__tests__/spawn-runtime-controls.test.ts`
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts`
- `src/main/plan-review/deep-review-session.ts`

That shared-workspace test run was **not green**: 7,123 passed, 62 failed, 6 skipped. All six scope-focused files passed in the full run. Failures involved the concurrent permission/runtime-preset implementation across adapter controls, handoff/spawn options, Feishu preferences/management, and UI labels or choices. Those edits were preserved and excluded from the independently validated commit; no claim is made that the complete shared workspace passed all tests.

The Electron SQLite binding SHA-256 matched before and after tests. No live session shutdown, message delivery, handoff, process restart, installation or deployment was used for validation.

## Prompt-asset validation

User Custom Points: none persisted. The user's approval of the recommended change, related runtime Markdown updates, and de-duplication is the scope/proposal confirmation. The prompt-asset-improver workflow used a fresh ignored local inventory and refreshed hashes; no redundant approval gate was requested. Local entrypoint links and bundled paths were checked. No new external source links need validation. Core spawn input schema was inspected and retained; host-specific output/timeout/worktree contracts were edited where needed. Installed user/runtime skill copies were untouched.

## Residual risk and follow-ups

- Shared-workspace full-suite and final typecheck failures above belong to ongoing out-of-scope work; rerun that suite after its permission UI implementation and tests agree.
- Query pages reflect live state; concurrent changes can reorder offset-based pages. The fixed bug was premature truncation, not snapshot consistency.
- The shutdown question expires in five minutes and never transfers its authority through handoff. Its Pending entry is cancelled by caller lifecycle/transport cancellation; late approval is revalidated before any close.
- The existing long tool fixture suite is retained for the concrete reason and revisit trigger in CHANGELOG_676. New production modules and focused regression files stay below 500 lines.
- Runtime activation remains pending. Only source and generated build outputs were changed; the running application was preserved.
