---
review_id: 272
reviewed_at: 2026-09-10
baseline_commit: 6f44829fd4a94ca5a047e9a761b7f300c8c1429a
expired: false
---

# Plan-review question runtime controls

## Scope and method

Investigate the reported question-send failure in the plan deep-review dialog. Trace the
renderer, IPC, review coordinator, and production spawn validation; reproduce the incompatible
runtime arguments before repairing them. This is a focused debugging and self-review pass.
No independent reviewer sessions were requested or started. The repository review-expiry scan
was consulted; all changed code was checked without relying on earlier coverage exemptions.

```review-scope
src/main/plan-review/deep-review-session.ts
src/main/plan-review/__tests__/deep-review-session.test.ts
src/renderer/components/pending-rows/PlanDeepReviewDialog.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog.test.tsx
src/renderer/components/pending-rows/PlanDeepReviewDialog-send-retry.test.tsx
```

## Findings and fixes landed

| Severity | Evidence | Resolution |
|---|---|---|
| MEDIUM | The review coordinator copied stored Claude permission modes into Codex fork arguments and forwarded sandbox fields regardless of adapter. Production spawn validation rejects these arguments before creating the child. The previous permissive spawn mock concealed this failure. | Forward only the source adapter's runtime controls. Preserve Codex approval policy, sandbox, network access, and additional directories; preserve Claude permission and sandbox settings, including the existing `dontAsk` normalization. Exercise the real spawn runtime validator in coordinator regressions. |
| LOW | Every send error suggested that the plan might no longer be pending, including child-creation failures. | Distinguish child-creation failure from question-send failure using the existing creation state. Keep provider diagnostics out of the UI. Verify that failed attempts retain the question and quotes, and that successful retries clear them and reuse an existing child. |

The plan decision gate, original session, native-fork requirement, and no-fresh-fallback behavior
are preserved. No prompt assets, database schema, IPC channels, or dependencies changed.

## Validation

- Before repair, the coordinator suite failed eight cases at the production runtime-control
  validator: the original Codex setup, five stored Claude permission modes on Codex, and two
  Claude cases with unrelated persisted sandbox fields.
- Focused review/coordinator/dialog/spawn-preflight coverage: 9 files and 85 tests passed.
- `pnpm typecheck` passed, including both architecture checks.
- `pnpm run test --maxWorkers=4 --minWorkers=1`: 1,027 files and 6,363 tests passed;
  two files and three tests intentionally skipped.
- The Electron-compatible test runner preserved the SQLite binding; its SHA-256 was unchanged
  before and after the full suite.
- `git diff --check` passed. All five changed source/test files are below 500 lines.
- Rebucket existing review records by `reviewed_at`, preserve their evidence destinations,
  and update affected index rows and links. No README change is needed for this bug fix.
- Archive checks passed for all 272 review records and 22 local links in changed documents.
  Nineteen older records moved; sixteen retained identical content and three only rebased links.

## Residual risk and follow-ups

- The screenshot does not include the underlying IPC exception, and available application logs
  did not contain that attempt. The incompatible-argument failure is independently reproduced
  against production validation; no credentialed provider fork was executed in the live app.
- The running installed Agent Deck application remains unchanged. Loading the main-process
  repair requires updating the installed application and restarting it. Any process stop,
  replacement, or relaunch requires explicit approval under the host runtime rules.
- No additional implementation follow-up was identified in this focused scope.
