---
review_id: 327
reviewed_at: 2026-10-14
baseline_commit: bb121d67cdccf1daec4cb336d63ed7ed4755b6be
expired: false
---

# Stabilize session metadata during startup

## Scope and method

Source investigation and regression validation of Gateway and context labels after session
creation. This is not a paired reviewer run or a live visual reproduction.

```review-scope
src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-new.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/create-session-new-latency.test.ts
src/renderer/components/SessionContextUsageChip.tsx
src/renderer/components/__tests__/SessionContextUsageChip.test.tsx
src/renderer/components/RemoteSessionSummaryCard.tsx
src/renderer/components/SessionDetail/RemoteSessionDetail.tsx
```

The review-expiry script exited with status 1 while mapping historical coverage. All changed
files were inspected directly; no earlier review coverage was used to exempt them.

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Codex emitted its provisional session before publishing already-known Gateway, model, and thinking metadata. The renderer could observe an incomplete first record. | Include the resolved metadata in the existing trusted `initialRuntime` payload. Keep later persistence and background native-thread startup intact. |
| LOW | Context chips immediately presented missing telemetry before a fast first snapshot arrived. | Reuse the shared 150 ms initial-presentation hook for Local chips and Remote summary snapshots. Reserve the placeholder's space invisibly during the grace period. |

## Presentation boundaries

- Available snapshots render immediately, including ordinary usage changes and compaction states.
- Missing telemetry becomes visible at 150 ms; it does not delay session creation or data reads.
- Presentation identity includes session, adapter, Gateway, and model. Changing identity resets the
  grace period synchronously; no previous snapshot is retained by the presentation layer.
- Remote detail passes session/runtime identity into the same chip. Authoritative read failures
  remain explicit rather than being hidden by a loading delay.
- Existing unattributed and cross-adapter snapshot guards remain in effect.

## Validation

- `pnpm typecheck` passed, including architecture and Node boundary checks.
- Full `pnpm test`: 1,160 files and 7,302 tests passed; 3 files and 6 tests skipped.
- Regression coverage includes first-event metadata before thread startup, Gateway model fallback,
  149/150 ms transitions, fast results, continuous usage updates, identity changes, and Remote parity.
- `git diff --check` passed. All changed source and test files remain below 500 lines.
- Reviewed all review date buckets; no existing record required rebucketing.

## Residual risk and activation

No live visual reproduction or installed-app validation was performed. The hidden placeholder
preserves its own dimensions; legitimate later token-label width changes remain possible.
Renderer changes use development HMR. The Codex startup fix requires a main-process restart;
no running Agent Deck process or installed application was restarted or replaced.

## Follow-ups

Verify newly created sessions visually after the user-approved development restart or next normal
application update. No README change is needed for this bug fix.
