---
review_id: 193
reviewed_at: 2026-07-29
baseline_commit: d31a04af522b41ae32567b471a37e97eaca6c831
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_193_grok-delivery-token-metric-scope: provider delivery, interrupts, and token fidelity

## Scope and method

Traced an installed-app Grok turn across Agent Deck's SQLite event ledger, the ACP child process,
Grok's native `updates.jsonl`, and direct Node 22 / Electron 33 ACP probes using the same binary,
login shell, FD3, cwd, instructions, plugins, and MCP configuration. Audited the provider-native
interrupt paths and today's raw token rows for Codex, Claude, and Grok.

```review-scope
src/main/adapters/claude-code/sdk-bridge/__tests__/sdk-message-translate-token-usage.test.ts
src/main/adapters/claude-code/sdk-bridge/final-result-usage.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts
src/main/adapters/claude-code/sdk-bridge/session-lifecycle.ts
src/main/adapters/token-usage-metric-scope.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/message-controller-handoff.test.ts
src/main/adapters/codex-cli/sdk-bridge/message-controller.ts
src/main/adapters/grok-build/__tests__/history-usage.test.ts
src/main/adapters/grok-build/__tests__/runtime-lifecycle-coordinator.test.ts
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/extension.ts
src/main/adapters/grok-build/provider-completion-recovery.ts
src/main/adapters/grok-build/history-usage.ts
src/main/adapters/grok-build/runtime-factory.ts
src/main/adapters/grok-build/runtime-lifecycle-coordinator.ts
src/main/adapters/grok-build/runtime-types.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/translation-types.ts
src/main/adapters/grok-build/turn-queue-types.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/grok-build/turn-response.ts
src/main/adapters/grok-build/usage-translate.ts
src/main/store/__tests__/db-offline-migration.test.ts
src/main/store/__tests__/v057-migration.test.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v057_token_usage_metric_scope_repair.sql
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Grok 0.2.114 completed inference and durably stored thought, assistant, exact usage, and `turn_completed`, while the installed Electron `session/prompt` remained pending. Exact Electron probes prove the transport stack normally works, so the failure is an intermittent provider completion-boundary stall rather than a permanently broken FD3/WHATWG stream. Agent Deck's architectural defect was treating one fallible ACP request as the only completion source even though Grok exposes a durable same-turn journal. | Reconcile every turn against the matching native journal. A normal ACP response now imports journal-only exact usage; a durable assistant + terminal can finish a stalled ACP request, after which the broken runtime is recycled without replay. |
| HIGH | The unified Codex interrupt only aborted the `turn/start` controller. After app-server accepted the turn, that signal no longer controlled model work or context compaction, and the existing `thread.interrupt(turnId)` was never called. Grok sent only `session/cancel`, leaving a stalled prompt Promise locally pending. | Codex now sends `turn/interrupt` and also aborts the local submission race. Grok sends `session/cancel`, aborts the matching JSON-RPC request (`$/cancelRequest`), and emits an interrupted terminal. Claude keeps SDK `query.interrupt()` but now propagates failures. The composer exposes idle/interrupting/error states. |
| HIGH | Grok 0.2.114 returns `usage=null` from healthy `session/prompt`; exact reasoning/cache usage is written to native `turn_completed`. The dashboard backfill cached its first completed scan forever, so turns created later in the same app process were never imported. | Healthy turns immediately reconcile their native terminal, and dashboard history scans are single-flight only while active, then rescan on later queries. Provider prompt ids keep both paths idempotent. |
| MEDIUM | Claude finalized result rows inherited the all-metrics default even when reasoning or cache fields were absent. One applicable NULL therefore made the exact daily reasoning aggregate display `—` despite known Codex and Grok reasoning data. | Build `metricScope` from fields actually reported and add startup migration v57 to repair the five affected non-Grok rows while preserving explicit zeroes and Grok's intentionally strict unknown deltas. |
| INFO | Codex app-server cache-write support was already present through `cacheWriteInputTokens`. Today's Codex rows carry metric scope 63 and explicit `cache_creation_tokens = 0`; the absence of a positive cache-write count is provider data, not a translator omission. | Retained zero as the exact value and added no synthetic cache-write data. |

## Evidence

- Agent Deck session `d13e216b-b248-41d0-a5e4-91b8245ecd16` stored only session start and user
  `hi`, while native Grok session `019fb165-1721-73c0-8abb-7891c324b99e` stored the assistant
  `Hi. What would you like to work on?`, reasoning, usage, and `end_turn` about nine seconds later.
- Direct ACP probes succeeded under Node 22 and Electron 33/Node 20 on the exact login-shell/FD3
  launch path, including home cwd, Agent Deck instructions, plugin, model/reasoning options, and MCP
  configuration. This excludes a deterministic Electron stream-conversion, authentication,
  packaging, or injected-asset defect.
- In a healthy real Grok turn, ACP returned `usage=null` while its matching native
  `_x.ai/session/update` contained input/output/reasoning/cache-read. Therefore native
  reconciliation is required for data fidelity even when message delivery succeeds.
- Codex interruption stopped at `AbortController.abort()` although accepted turns were tracked by
  `currentTurnId` and the native interrupt method already existed.
- Today's Codex rows repeatedly report nonzero reasoning/cache-read and exact cache-write zero with
  full metric scope.
- Applying v57 semantics read-only to today's real ledger yields known reasoning for Codex and
  Grok; the Claude bucket becomes non-applicable instead of unknown.
- The overall cache-write aggregate intentionally remains `—`: Grok reports that dimension as an
  applicable unknown, while Codex and Claude report exact zero. Strict aggregation must not turn
  the unknown Grok contribution into zero.

## Validation

- Grok normal/stalled journal reconciliation, repeated history import, provider interruption,
  Codex native interruption, composer feedback, Claude translator, and v57 focused regressions
  passed.
- Electron-ABI SQLite migration and offline-boundary regressions passed: 19 tests.
- `pnpm typecheck` passed.
- `pnpm build` passed for main, preload, and renderer bundles.
- `pnpm dist` verified bundled Grok 0.2.114 and produced the Darwin ARM64 app and DMG with dirty
  build metadata at 2026-07-30T05:56:44.811Z.
- The 365,881,310-byte DMG passed `hdiutil verify` and has SHA-256
  `3a0125e2fa02dfd42c2a97758985106ae0b38090a6577ae818790e96827a241f`.
- Because no Developer ID is installed, the unpacked packaged app was ad-hoc re-signed and then
  passed strict deep signature verification.
- Full Electron-ABI suite passed: 470 files and 4,016 tests passed; one file and one test skipped.
- `bash scripts/file-level-review-expiry.sh` and `git diff --check` passed.
- All changed first-party source files are at or below the 500-line guardrail.

## Fixes landed

- Made the Grok durable same-turn journal a normal usage reconciliation source and a stalled ACP
  completion source, without prompt replay or a long-turn deadline.
- Repaired the forever-memoized Grok history scan.
- Unified provider-native and local-request interruption across Codex/Grok while retaining Claude's
  SDK interrupt, and added visible composer interruption state.
- Avoided duplicate assistant output when standard ACP content was observed before recovery.
- Added explicit native-session path validation and bounded history reads.
- Corrected Claude metric applicability at the translator and existing-data levels.
- Extracted finalized Claude usage translation so every changed source file satisfies the 500-line
  guardrail.
- Updated migration-boundary tests so a startup migration may follow offline v56.

## Residual risk

- Grok's exact optional token dimensions currently exist only in its native session journal, so the
  integration depends on that versioned session-root contract. ACP remains the primary live-text
  source; the journal is authoritative for exact usage and terminal recovery.
- The dashboard's overall cache-write value remains `—` while Grok's cache-write contribution is
  unknown. This is intentional exactness, not a missing Codex value.
- The currently running installed app cannot adopt main-process changes without a restart. Package
  and install verification must occur after this active Agent Deck session exits.

## Follow-up

Package and replace the installed application after it exits, then verify: a normal Grok prompt
immediately writes reasoning/cache-read usage, a deliberately interrupted Codex compaction receives
`turn/interrupt`, and a stalled Grok turn can be interrupted without leaving its prompt pending.
