---
review_id: 214
reviewed_at: 2026-08-04
baseline_commit: 6c313453857718baf656429f800dc0b2321c1b28
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review, changelog, rebucketing, and bucket-index maintenance are mechanical records."
---

# REVIEW_214_diff-history-and-runtime-diagnostics: Diff freshness and runtime log signal

## Scope and method

This implementation and self-review started from the reported delayed Diff view and a disappearing
`加载更多` control, then correlated the behavior with the current file-change pages and recent
application logs. Neither `simple-review` nor `deep-review` was invoked.

```review-scope
src/main/adapters/codex-cli/app-server/generation-operation.test.ts
src/main/adapters/codex-cli/app-server/generation-operation.ts
src/main/index.ts
src/main/index/__tests__/bootstrap-diagnostics.test.ts
src/main/index/__tests__/main-index-observability.test.ts
src/main/index/bootstrap-diagnostics.ts
src/main/ipc/__tests__/provider-usage.test.ts
src/main/ipc/provider-usage.ts
src/main/session/continuation-context/__tests__/checkpoint-refresh-diagnostics.test.ts
src/main/session/continuation-context/__tests__/checkpoint-refresh-service.test.ts
src/main/session/continuation-context/checkpoint-refresh-diagnostics.ts
src/main/session/continuation-context/checkpoint-refresh-service.ts
src/main/session/worktree-transition/__tests__/coordinator-observe.test.ts
src/main/session/worktree-transition/__tests__/diagnostics.test.ts
src/main/session/worktree-transition/coordinator-helpers.ts
src/main/session/worktree-transition/coordinator.ts
src/main/session/worktree-transition/diagnostics.ts
src/main/utils/__tests__/runtime-correlation.test.ts
src/main/utils/runtime-correlation.ts
src/preload/api/sessions.ts
src/renderer/components/SessionDetail/DiffTab.tsx
src/renderer/components/SessionDetail/__tests__/use-file-changes.test.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionDetail/use-file-change-payload.ts
src/renderer/components/SessionDetail/use-file-change-selection.ts
src/renderer/components/SessionDetail/use-file-changes.ts
src/renderer/components/activity-feed/viewers/activity-event-identity.ts
src/renderer/lib/agent-event-identity.ts
src/renderer/stores/__tests__/session-store.test.ts
src/renderer/stores/session-store-events.ts
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Diff selection survived new file-change events as long as the old row still existed, so an active session could remain pinned to an older revision indefinitely. A session id also survives an automatic worktree cwd transition. | Added an explicit follow-latest state machine. New changes update the selection until manual history navigation; cwd changes reset the list, selection, and payload before paint. |
| MEDIUM | Pagination is record-based while the UI groups records by file. A 50-row page can add only older revisions of visible files, making the click appear inert; the button then disappears when the cursor is exhausted. | Kept record paging but report added records, newly discovered files, total records, and exhaustion after every click. Labels now say that the action loads older changes. |
| MEDIUM | Successful provider reads around two to four seconds and checkpoint refreshes that were slow or making bounded partial progress were emitted as warnings. | Raised the provider slow threshold to four seconds and demoted successful slow/advancing states to info. Stalls, failures, and timeouts remain warning states with recovery tracking. |
| MEDIUM | Worktree transition logs did not separate tool acknowledgement, cwd switch, persistence, cleanup, continuation delivery, and provider response, so the observed delay could not be localized. Expected accepted-turn Codex recycling also appeared as a warning. | Added structured phase durations and run-scoped session correlation, including continuation-to-first-provider-event latency; classified the expected recycle as info. |
| LOW | Fatal bootstrap logs identified only a generic failure phase and did not retain a safe actionable root-cause summary. | Added stage, sanitized error class/message/code, and a stable fingerprint. Diagnostic helper and sink failures remain contained by the terminal bootstrap sequence. |
| LOW | Historical activity rows already carry unique SQLite ids, but the preload type and React identity discarded that durable distinction; exact duplicate live events could also enter the store. | Preserve durable ids in the renderer contract, use them for identity, retain a full live-event digest fallback, and deduplicate identical generic events without merging distinct durable rows. |

No confirmed finding remains open.

## Evidence from recent logs and data

- The inspected session contained 130 change records across 32 paths. Its first page exposed 31
  paths; the second page added 50 records but only one new path; the final 30 records all belonged
  to an already visible path. This reproduced the invisible pagination result without implicating
  Git worktree switching.
- The current run had no application errors. Seven successful provider-usage reads took roughly
  2.3–3.9 seconds, two checkpoint operations made bounded progress over roughly 173–179 seconds,
  one event-loop warning was transient, and one Codex recycle was the expected accepted-turn path.
- The worktree tool transition itself was roughly 358 ms; the next provider event arrived about
  20.7 seconds later. The new phase logs can distinguish this provider continuation latency from
  filesystem and persistence work on future runs.
- A historical burst of duplicate React-key messages from July 31 had not recurred in newer logs;
  durable event identity was still hardened to prevent the same collision class after reload.

## Validation and evidence

- Focused regression suites covered follow-latest/manual selection, cwd reset, payload request
  fencing, same-file exhausted pages, persistent pagination feedback, durable event ids, provider
  recovery from timeout into slow success, checkpoint progress/stall classification, worktree phase
  timing, diagnostic cancellation, expected Codex recycling, and bootstrap redaction/containment.
- Full Electron-ABI suite passed 469 files and 3,866 tests; one credentialed live-provider smoke
  remained intentionally skipped.
- Node and renderer typechecks, the production main/preload/renderer build, logger validation, and
  diff whitespace checks passed.
- Review-expiry inventory was generated. Changed production files remain below the 500-line guard;
  the worktree coordinator is 485 lines.

## Residual risk

- The installed Agent Deck process owns this delivery session and was not restarted or replaced.
  Source behavior therefore takes effect after the next normal rebuild/install and app restart.
- Component-level interaction is covered by the renderer tests, but the active installed Electron
  window cannot display the uninstalled source changes for a live click smoke in this session.
- The four-second provider threshold intentionally leaves a narrow one-second slow-info band before
  the existing five-second timeout; provider errors and timeouts remain unchanged.

## Final verdict

ACCEPT. The UI now makes every pagination outcome visible and follows new work unless the user
chooses history. Log levels reflect outcome rather than duration alone, and worktree/continuation
latency is content-free, bounded, and phase-correlated without changing runtime behavior.

## Related records

- `CHANGELOG_432_diff-history-and-runtime-diagnostics.md`
