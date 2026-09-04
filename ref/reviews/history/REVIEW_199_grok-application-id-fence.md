---
review_id: 199
reviewed_at: 2026-07-30
baseline_commit: 49129f80b56667848803cfc77ab4122638e16d94
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_199_grok-application-id-fence: Grok stable identity deletion fence

## Scope and method

Traced the installed-app failure across Grok's native 429 terminal, the adapter event sink,
`SessionManager.ingest`, and the SQLite ledger. Reproduced the failure in an isolated app
`userData`, instrumented the durable sink temporarily to locate the exact drop boundary, removed
that instrumentation, fixed the shared native-id update invariant, and reran the same real Grok
request against a fresh isolated database.

```review-scope
src/main/session/__tests__/manager-public-api.test.ts
src/main/session/manager/rename.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | A fresh Grok session has distinct application and native session ids. When the native id was first persisted, `updateCliSessionIdImpl` treated the stable application id as a retired CLI id and put it in the 60-second deletion fence. Every subsequent SDK assistant/error/finished event used that stable id and was therefore dropped by `SessionManager.ingest`, leaving the UI permanently `working`. | On initial native-id binding, where no prior `cli_session_id` exists, update the column without creating a deletion fence. Never infer a retired CLI identity from the stable application id. |
| HIGH | Earlier Grok terminal regressions stopped at the adapter's in-memory event sink. They proved that Grok's rate-limit terminal was translated, but did not prove that the translated events survived the identity/fencing layer and reached SQLite. | Added a SessionManager regression that starts with a null native id, binds Grok's first native id, persists assistant and finished events through the stable application id, and verifies that a later native-id rotation still fences only the genuinely retired native id. |

## Evidence

- Installed session `4979fb3e-73e8-40da-b939-b763a46a50d9`, native Grok session
  `019fb24d-4bcd-7e10-b8af-287692e0952c`, received Grok's real
  `turn_completed / rate_limit` terminal but retained only `session-start` and user `hi` in SQLite.
- An isolated packaged reproduction, application session
  `d394fd19-6779-41fa-b42a-dc51c3ae0514`, reproduced the same two-row ledger and
  `activity=working`.
- Temporary boundary diagnostics proved that the adapter invoked the application event sink with
  both the rate-limit message and `finished`, while `SessionManager` returned without inserting
  either row. The diagnostics were removed after locating the fence.
- After the invariant fix, real Grok session
  `019fb268-02f2-7c10-8a86-1e3cab4c3d77` produced application session
  `931855e8-f02d-41c1-9570-6075a506dc3a`. Its SQLite ledger contains, in order:
  `session-start`, user `hi`, the Simplified Chinese rate-limit error, and
  `finished { ok:false, subtype:"rate_limit" }`; the session activity is `finished`.
- The provider account remains over its rolling free quota (`505692 / 500000` tokens), so this
  live verification exercised the exact failure path that users were seeing.

## Validation

- Focused SessionManager regression passed: 11 tests.
- Full Electron-ABI suite passed: 475 files and 4,046 tests; one file and one test skipped.
- `pnpm typecheck`, `pnpm build`, and `bash scripts/logger-check.sh` passed.
- A real Grok ACP process plus the production SessionManager and a real isolated SQLite database
  passed the failure-terminal persistence check.
- Both changed first-party files remain below 500 lines.

## Residual risk

- The local Grok account cannot currently exercise a successful model answer because its rolling
  quota is exhausted. Successful answer translation remains covered by the existing adapter tests;
  the identity regression is provider-outcome agnostic and now proves that all post-binding SDK
  events can reach durable storage.
- Native-id rotation still fences an actual prior `cli_session_id`, preserving the late-hook ghost
  protection that the original helper was designed to provide.
