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
- `pnpm dist:mac` produced a clean `e1dabf382f88` package and the packaged Worker sandbox check
  passed. The user installed and reopened that exact build without process manipulation.
- Official Relay `--check`, `--dry-run`, `--upgrade`, and independent `--verify` passed. The healthy
  release is `git-e1dabf382f88` at image digest
  `sha256:a47919cd545b5013240c22eea0bdc4cab8c68c2c3be00167582963090ca69179`.
- Official Worker `--check`, `--dry-run`, `--upgrade`, and independent `--verify` passed for
  `worker-df9dfaddfd410be3979119c7` using the isolated `~/AgentDeckWorkspaces` root.
- Startup recovery populated 9 keyed legacy rows while retaining all 9 legacy events. Live
  acceptance then raised `token_usage` to 13; the two new provider sessions contributed 4 ledger
  rows and 0 new `token-usage` history events.
- A fresh Relay client negotiated protocol 2.1 and 21 capabilities, loaded Teams and Issues, read
  an authoritative active-session total of 8, returned 2 daily usage rows, and observed a non-empty
  rolling `gpt-5.6-sol` token rate after a live follow-up.
- Claude `deepseek` / `deepseek-v4-flash[1m]` / `max` returned
  `CLAUDE_DEEPSEEK_E1_TOKEN_USAGE_OK`; Codex `gpt-5.6-sol` / `low` returned
  `CODEX_GPT_5_6_SOL_E1_TOKEN_USAGE_OK` and the rolling-rate follow-up marker.
- `git diff --check` passed and all modified production files remain below 500 lines.

## Residual risk

- Legacy unkeyed telemetry cannot be replayed without risking duplicate accounting and is therefore
  skipped. Current production evidence contains only keyed rows.
- Legacy token events remain in historical storage. New events no longer enter that path; deletion
  is intentionally excluded from this non-destructive recovery.

## Verdict

PASS. Full validation, exact-commit packaging, official Relay/Worker deployment, keyed recovery,
Remote workspace reads, and real Claude/Codex token-usage acceptance all completed successfully.
