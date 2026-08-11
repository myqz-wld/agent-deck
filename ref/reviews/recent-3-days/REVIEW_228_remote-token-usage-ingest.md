---
review_id: 228
reviewed_at: 2026-08-10
baseline_commit: d50a875be23f051cfdfb13f7f0992a56077ea430
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and changelog maintenance are mechanical records."
---

# REVIEW_228_remote-token-usage-ingest: Remote token telemetry persistence

## Scope

```review-scope
src/hosts/server-core/repository-host.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/session-manager-observer.test.ts
src/hosts/server-core/session-manager-observer.ts
src/hosts/server-core/session-manager.test.ts
src/hosts/server-core/session-manager.ts
src/hosts/server-core/token-usage-backfill.test.ts
src/hosts/server-core/token-usage-backfill.ts
src/main/session/manager-ingest-pipeline.ts
src/main/store/token-usage-repo.ts
```

## Finding

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Server Core treated `token-usage` as an ordinary event. It wrote telemetry into `events`, advanced session history/activity, and never populated `token_usage`; Remote Data and tok/s therefore stayed empty after successful sessions. | Route token telemetry through a dedicated observer, share the Local projection, return before history persistence, and safely recover keyed legacy rows. |

## Production evidence

- The deployed protocol 2.1 Core advertised `usage`, and `usage.tokens.get` itself succeeded.
- Claude `deepseek-v4-flash[1m]` at `max` and Codex `gpt-5.6-sol` at `low` both returned their exact
  acceptance markers; the authoritative live total increased from 4 to 6.
- After completion, `rates`, `topToday`, and `daily` remained empty for ten reads.
- Read-only SQLite inspection found 9 `events.kind = 'token-usage'` rows with provider metrics and
  stable message ids, but 0 rows in `token_usage`. This isolates the fault to Server Core ingestion,
  not capability negotiation, Relay transport, provider translation, or the usage query.

## Fix review

- Deduplication and SDK/hook ownership fencing still precede telemetry handling.
- `token-usage` now returns before session materialization, history persistence, and activity
  advancement, matching the established Local invariant.
- One shared projection constructs token ledger inputs for Desktop and Server Core, preventing field
  drift across total/input/output/reasoning/cache metrics and Grok replacement metadata.
- Persistence failure is caught at the headless observer boundary and cannot interrupt provider
  delivery. A revision is published only after persistence succeeds.
- Startup recovery replays only rows with a non-empty provider message id. Existing partial-unique
  upsert semantics make repeated starts safe; invalid or unkeyed legacy rows are counted and skipped.
- Recovery does not delete or rewrite historical `events`, avoiding destructive migration of a live
  Worker database.

## Validation

- Focused telemetry and Server Core suites passed 61 tests across 6 files, including the real
  Electron/native SQLite runtime-composition suite.
- The full suite passed 878 files and 5,713 tests; 2 files and 3 tests were skipped.
- `pnpm typecheck` passed architecture and Node/Web TypeScript checks.
- Production build, Linux headless build/check, deployment automation check, and macOS Worker
  sandbox verification passed.
- `git diff --check` passed and all modified production files remain below 500 lines.
- Package and production post-deployment acceptance results will be added before final handoff.

## Residual risk

- Legacy unkeyed telemetry cannot be replayed without risking duplicate accounting and is therefore
  skipped. Current production evidence contains only keyed rows.
- Legacy token events remain in historical storage. New events no longer enter that path; deletion
  is intentionally excluded from this non-destructive recovery.

## Verdict

PASS for implementation validation. Final release acceptance remains contingent on full validation,
official Worker deployment, and non-empty production Remote usage reads after real model sessions.
