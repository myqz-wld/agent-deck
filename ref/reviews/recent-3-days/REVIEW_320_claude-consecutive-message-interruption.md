---
review_id: 320
reviewed_at: 2026-10-13
baseline_commit: c392830544bb61b79a8ce86eb3445dd426b68fb1
expired: false
---

# Claude consecutive message interruption

## Scope and method

Owner-reported screenshot diagnosis, source tracing, installed SDK type inspection, and
deterministic provider-frame regressions. No independent paired review was requested or run.
The review-expiry helper was attempted; it exited during a pre-existing scope with a trailing
blank line. Latest covering baselines, commit counts, and churn were checked directly for all
changed files. No earlier review was used to exempt any changed source from inspection.

```review-scope
src/main/adapters/claude-code/sdk-bridge/pending-outgoing-core.test.ts
src/main/adapters/claude-code/sdk-bridge/pending-outgoing-core.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.test.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor-core.test.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor-core.ts
src/main/adapters/claude-code/sdk-bridge/types.ts
src/main/adapters/claude-code/sdk-bridge/user-message-interruption-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-interruption-core.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts
```

## Findings and fixes landed

1. MEDIUM: composer corrections stream with `priority: 'now'`. An interrupted SDK turn can
   return `error_during_execution` with the exact user-interruption diagnostic shown in the
   owner's screenshot, which the application projected as an execution failure. Track the IDs
   of corrections actually submitted during an active turn, independently of their acceptance
   echoes. Normalize only the known diagnostic, with an absent or compatible abort reason, when
   a later correction still awaits its result. Emit the existing `interrupted` outcome while
   retaining usage accounting and subsequent input delivery. Other errors remain visible.
2. MEDIUM: an acceptance echo could clear `submittingUserMessage` before the preceding result
   arrived, causing that old result to mark the provider idle despite an accepted correction.
   Keep the turn active while tracked corrections or SDK-reported queued turns remain. Settle
   IDs using result correlation, including coalesced inputs and producers echoing only the final
   UUID. Successful cancellation removes only its own ID. Uncorrelated legacy results clear
   their interruption evidence so it cannot mask an unrelated later failure.

## Validation and evidence

- The exact thinking-phase diagnostic is independently reported in the SDK's
  [upstream issue 366](https://github.com/anthropics/claude-agent-sdk-typescript/issues/366);
  [issue 405](https://github.com/anthropics/claude-agent-sdk-typescript/issues/405) describes
  the tool-interruption variant. These reports support the diagnostic classification, not
  a claim that this installation was reproduced against a live model.
- Installed SDK declarations document result input UUID correlation, coalesced input lists,
  `queued_turn_count`, and abort terminal reasons.
- Regressions cover consecutive corrections, echoes before/after the old result, multiple
  accepted corrections before that result, legacy uncorrelated results, cancellation,
  coalesced messages, and failures of the correction itself. Exact and mixed API failures
  remain errors; an idle session cannot claim a user-message interruption.
- `pnpm typecheck` passes both TypeScript projects and architecture/Core Node boundaries.
- Full `pnpm test`: 1,143 files and 7,140 tests passed; 3 files and 6 opt-in tests skipped.
  A final additional legacy-result regression and idle-input assertion passed with both
  affected suites (12 tests), followed by another successful typecheck.
- `git diff --check` passes. All changed source and test files remain below 500 lines.
- Review records were rebucketed by date, with affected indexes updated. No README change is
  needed for this bug fix.

## Residual risk and activation

Validation uses deterministic SDK frames, not a live provider conversation. Unknown diagnostics
remain visible rather than being broadly suppressed. Existing error history is unchanged.
The installed application requires an updated build and a main-process restart to activate the
repair. No installed application, Worker, live provider, or development process was changed.

## Follow-ups

After an authorized application update, verify consecutive owner messages in a live Claude
session. Application replacement and restart remain separate from source validation.
