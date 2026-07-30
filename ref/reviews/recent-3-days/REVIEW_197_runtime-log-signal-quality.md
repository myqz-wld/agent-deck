---
review_id: 197
reviewed_at: 2026-07-30
baseline_commit: a72d31d89a43033ea5d1136dc663c99701fcd841
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_197_runtime-log-signal-quality: runtime log signal quality

## Scope and method

Traced the latest installed-app warnings back through provider-usage polling, Browser native-pipe
transport diagnostics, database startup migration gating, and the main event-loop sampler. Compared
warning timestamps with macOS suspend/resume evidence, then added failure-first assertions for
diagnostic cardinality, fixed-field context, redaction, and power-event rebasing.

```review-scope
src/main/browser-use/__tests__/connection.test.ts
src/main/browser-use/__tests__/server.test.ts
src/main/browser-use/server.ts
src/main/browser-use/transport-diagnostics.ts
src/main/index/__tests__/checkpoint-bootstrap-entry.test.ts
src/main/index/bootstrap-infra.ts
src/main/ipc/__tests__/provider-usage.test.ts
src/main/ipc/provider-usage.ts
src/main/store/__tests__/db-offline-migration.test.ts
src/main/store/db.ts
src/main/utils/__tests__/main-event-loop-monitor.test.ts
src/main/utils/main-event-loop-monitor.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Expected `not_subscribed` and `unsupported` provider states produced warnings, each timed-out read could produce a second late `slow` warning, and one-minute summaries were shorter than the ten-minute cache cadence. Actual provider failures lacked a provider key. | Treat expected account/capability states as diagnostically healthy, retain one timeout signal while still accepting a late cache refresh, summarize persistent degradation hourly, and add only the fixed provider id to operational diagnostics. |
| MEDIUM | Browser handler failures emitted the same sanitized diagnostic in both transport and bootstrap scopes while omitting the failed operation. | Keep transport as the single log owner. Bootstrap no longer re-logs its callback, and handler failures include only an allowlisted operation plus request/notification kind; unknown methods remain `unknown`. |
| MEDIUM | A 29-second macOS sleep and wake appeared as main event-loop lag because it was below the existing 60-second clock-gap heuristic. | Subscribe the sampler to Electron `powerMonitor` suspend/resume, skip samples while suspended, rebase on resume, and remove listeners on shutdown. The clock-gap heuristic remains as a fallback. |
| LOW | Offline migration startup warnings reported only the effective version and broad state, so the required target could not be identified from persisted logs. | Add fixed failure kind/code plus current and target versions without recording the database path, migration command, or raw exception. |

## Evidence

- The inspected run contained no application errors; seven of eight warnings came from provider
  usage diagnostics, including expected account state and a timeout followed by a late slow result.
- Each Browser handler failure appeared once in `browser-transport` and once in `bootstrap-infra`
  with the same sanitized payload.
- The two event-loop delays matched macOS sleep/dark-wake intervals rather than active main-process
  work.
- Provider tests prove late success still refreshes the cache while emitting only `timeout-empty`;
  account/capability states emit no warning and no subscription-state string.
- Browser tests prove known operations are retained, unknown method text and raw exception content
  are absent, and server startup failures still emit one sanitized transport diagnostic.
- The V55 migration test proves current version 55, target version 56, and the fixed error code are
  logged without the user-data path or migration command.

## Validation

- Focused non-SQLite Vitest: 5 files and 41 tests passed.
- Focused Electron-ABI database suite: 18 tests passed.
- Full Electron-ABI suite: 474 files and 4,040 tests passed; one file and one test skipped.
- `pnpm typecheck` passed.
- `pnpm logger:check` passed with no first-party `console.*` residue.
- `pnpm build` passed for main, preload, and renderer bundles.
- The Electron `better-sqlite3` binding was force-rebuilt after real SQLite tests.
- `bash scripts/file-level-review-expiry.sh` and `git diff --check` passed.
- `src/main/browser-use/server.ts` is 485 lines after diagnostics extraction; every changed
  first-party source file is below the 500-line guardrail.

## Fixes landed

- Reduced provider warning volume while preserving actionable provider correlation and cache
  freshness.
- Consolidated Browser transport logging and added redacted operation classification.
- Added safe offline-migration version metadata.
- Made event-loop diagnostics aware of system suspend/resume.
- Added targeted regression coverage for log count, redaction, lifecycle cleanup, and startup
  wiring.

## Residual risk

- Provider account/capability states remain visible in the requested usage snapshot but are
  intentionally absent from persisted operational diagnostics.
- Electron power events are the primary defense for short sleeps; the existing 60-second
  clock-gap rebase remains the fallback if the operating system does not deliver those events.
- No live development restart was performed because the running installed Agent Deck instance owns
  this session. Unit, integration, Electron-ABI, and production-build validation passed.

## Follow-up

After the current Agent Deck process exits, restart with this source build and confirm the next
runtime log has one Browser warning per incident, no expected provider-state warnings, and no
event-loop warning across a short system sleep.
