---
review_id: 183
reviewed_at: 2026-07-27
baseline_commit: 82f5f8e6ad0783e75fd00142e693ef274c6a40b5
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Changelog, review record, and bucket-index maintenance are mechanical archive work."
---

# REVIEW_183_token-usage-visibility-regression: Daily aggregate disappearance

## Scope and method

The investigation traced the Data panel from the production SQLite rows through migration v051,
metric-scoped aggregation, Codex app-server translation, and renderer formatting. The live database
was inspected read-only; no production data was modified.

```review-scope
src/main/adapters/codex-cli/app-server/token-usage-translate.ts
src/main/adapters/codex-cli/app-server/translate.ts
src/main/adapters/codex-cli/app-server/translate.test.ts
src/main/store/migrations/v052_token_usage_metric_scope_repair.sql
src/main/store/migrations/index.ts
src/main/store/__tests__/v052-migration.test.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/session-repo/__tests__/_setup.ts
src/main/store/__tests__/db-shutdown-guard.test.ts
src/renderer/components/DataPanel.tsx
src/renderer/components/data-panel/TokenTotalCard.tsx
src/renderer/components/__tests__/DataPanel.test.tsx
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | v051 converted ambiguous legacy zeroes to `NULL` but assigned `metric_scope=63`; one applicable `NULL` therefore hid an entire bucket/day containing thousands of valid rows. | v052 derives non-Grok historical applicability from retained provider facts while keeping Provider total strict. |
| MEDIUM | Codex app-server partial and empty usage notifications omitted `metricScope`, so persistence defaulted every absent field to applicable and could recreate the same poisoning after migration. | Partial deltas now carry a presence-derived mask; empty deltas are dropped. |
| LOW | Output totals used status green despite being a neutral accounting value parallel to input totals. | Summary and detail output values now use the normal text color. |
| LOW | The shutdown guard test opened Electron's persistent test user-data database, allowing stale schemas to leak across runs. | The test now uses and removes an isolated temporary user-data directory. |

## Validation and evidence

- The production database retained more than 116,000 usage rows. A read-only v052 simulation
  restored today's Codex values to approximately 397 million input, 1.44 million output, and
  634 thousand reasoning tokens.
- The focused Electron-ABI suite passed 58 tests covering v052, repository aggregation, Codex
  translation, and Data panel rendering.
- The full Electron-ABI suite passed 390 files and 3,284 tests; one credentialed live smoke test
  remained skipped.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- The packaged arm64 `.app` was ad-hoc signed and passed strict deep signature verification.
- `bash scripts/file-level-review-expiry.sh` completed before finalization.

## Fixes landed

- Historical non-Grok metric masks are repaired without rewriting retained numeric facts.
- New Codex deltas cannot poison unrelated daily metrics or create empty usage rows.
- Strict Grok cumulative-unknown semantics and strict Provider totals are preserved.
- Output totals no longer receive green status emphasis.
- Changed production files remain below 500 lines.

## Residual risk

- v052 intentionally does not reinterpret Grok rows; a genuinely unknown Grok cumulative delta
  remains capable of making that metric unavailable for the affected bucket/day.
- The live installed application needs a rebuilt package and restart before v052 can update its
  database. The running app was not overwritten during this session.
- DMG creation was blocked by repeated macOS `hdiutil` resource-unavailable errors. The incomplete
  DMG artifacts were removed; the verified `.app` bundle remains available.

## Follow-ups

None required after the rebuilt application is installed and restarted.
