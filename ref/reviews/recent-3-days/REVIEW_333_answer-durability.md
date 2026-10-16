---
review_id: 333
reviewed_at: 2026-10-15
baseline_commit: e4f4a08c75439be07b342163e78ddac3e1aca08d
expired: false
---

# Answer persistence before acknowledgement

## Scope and method

Lead-owned reproduction and repair authorized by PLAN_97 T07. This is not an independent paired
review. The earlier repeated-question incident is not proof that Agent Deck lost an answer.

```review-scope
src/main/ask-user/service.ts
src/main/agent-deck-mcp/__tests__/ask-user.test.ts
src/hosts/server-core/mcp-presentation.ts
src/hosts/server-core/mcp-presentation.test.ts
src/hosts/server-core/mcp-ask-user.test.ts
src/hosts/server-core/runtime-mcp-host.ts
src/main/store/__tests__/answer-recovery.test.ts
```

## Findings and repairs

1. MEDIUM: Local `AskUserService.respond` deleted Pending and resolved the provider result before
   best-effort answer publication. Injecting a storage failure still returned success and left no
   recoverable pending question. The new test failed before the repair. Answer publication now
   completes synchronously before acknowledgement; failure leaves the question available to retry.
2. MEDIUM: Core MCP ask responses resolved their waiting tool without retaining the answer in the
   session's event history. The outer mutation receipt did not supply continuation evidence.
   A second regression failed before the repair. Core presentation now requires a durable answer
   callback, wired to session ingestion in production, before resolving the pending tool.

Settlement guards handle a synchronous abort, finish, close or committed handoff during
publication. A successfully persisted answer wins; failed publication honors any deferred
cancellation. Invalid input, wrong ownership, unanswered cancellation and duplicate-submission
behavior remain unchanged. There is no permission expansion or new model call.

## Validation

The two publication-failure regressions failed before changes. After repair, 41 targeted tests
passed across Local MCP, Core MCP, presentation settlement, real SQLite answer persistence and
continuation normalization. Tests include answer-before/after-abort ordering, finish, close,
handoff rollback/commit, storage failure followed by retry, and retained answers in revision
source material after interruption. Final full-suite results are linked from
[PLAN_97 validation](../../plans/recent-3-days/PLAN_97_native-work-strip-support/validation.md).

## Residual risk

This fixes reproduced application behavior; it does not establish the cause of the earlier
conversation incident. An unanswered request still cancels when its provider/session closes.
The work does not restore answers never acknowledged by the application or guarantee recovery
from physical storage corruption. The existing ingestion transaction and failure semantics are
retained. No running Agent Deck instance was restarted during validation.
