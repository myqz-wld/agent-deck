---
review_id: 164
reviewed_at: 2026-07-16
baseline_commit: ecb75c18eab4f09514f577b0c38ef8078b3afdf5
expired: false
skipped_expired:
  - file: "*"
    reason: "This focused diagnostic fix covers only checkpoint refresh log classification and its regression test."
---

# REVIEW_164_checkpoint-partial-progress-logging: Checkpoint partial-progress log classification

## Scope and method

This focused diagnostic review traced repeated `background refresh failed` entries through the
scheduler, bounded fold limits, persisted checkpoint revisions, and the active session database.
It distinguished successful partial revision progress from provider, validation, commit, and
zero-progress failures.

```review-scope
src/main/session/continuation-context/__tests__/checkpoint-refresh-service.test.ts
src/main/session/continuation-context/checkpoint-refresh-service.ts
```

## Finding

| Severity | Finding | Resolution |
|---|---|---|
| LOW | A bounded refresh that durably advanced the checkpoint but did not cover the full materialized source was logged as `background refresh failed`, producing repeated warning noise during legitimate catch-up. | Classify only diagnostic-free incomplete refreshes whose checkpoint revision advanced as `background refresh partially completed` at info level. Keep zero-progress and explicit fold/provider failures at warning level. |

## Validation evidence

- The regression proves a refresh advancing revision 10 to 50 of 100 emits structured partial-
  completion info with the remaining materialized revision count and no matching failure warning.
- `pnpm typecheck` passed.
- `pnpm test` passed 318 files and 2,897 tests; one credentialed live smoke remained skipped.
- `pnpm logger:check`, `bash scripts/file-level-review-expiry.sh`, and `git diff --check` passed.
- The Electron native dependency was restored with the repository `postinstall` workflow after the
  full SQLite test suite.

## Fixes landed

- Preserve scheduler retry and backoff behavior; only the owning log classification changes.
- Include observed source, materialized, checkpoint, remaining-materialized, and retry fields in
  the partial-progress record.
- Retain the existing warning payload for no-progress incomplete coverage and real fold failures.

## Residual risk and deployment note

- Partial progress remains represented as a rejected scheduler attempt so the bounded backlog is
  retried after backoff. This change deliberately does not alter scheduling or provider budgets.
- The running Agent Deck host was not restarted from inside its active SDK session. Restart the
  application before expecting the installed main process to emit the new classification.

## Follow-ups

No in-scope follow-up remains.
