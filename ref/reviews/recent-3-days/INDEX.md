# Recent 3 Days Reviews

## Scope

This bucket contains only reviews that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `reviewed_at` is within the last 3 days, inclusive |
| `recent-week` | `reviewed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `reviewed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `reviewed_at` is older than 30 days, or missing a parseable date |

## Index Table

| reviewed_at | File | Topic | Severity Distribution |
|---|---|---|---|
| 2026-08-03 | `REVIEW_211_provider-token-accounting-and-rate-repair.md` | Provider token totals and tok/s | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed |
| 2026-08-03 | `REVIEW_210_worktree-inflight-message-continuity.md` | Worktree in-flight message continuity | 0 CRITICAL / 3 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-31 | `REVIEW_209_review-208-defect-remediation.md` | Final integration of all REVIEW_208 findings | 0 CRITICAL / 4 HIGH fixed / 10 MEDIUM fixed / 1 LOW fixed |
| 2026-07-31 | `REVIEW_208_compatibility-and-defect-audit.md` | Compatibility cleanup and functional defect audit | 4 HIGH / 10 MEDIUM / 1 LOW; closed by REVIEW_209 |
| 2026-07-31 | `REVIEW_207_exit-worktree-output-schema-compatibility.md` | MCP Zod output validation | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-07-31 | `REVIEW_206_runtime-selector-hook-security.md` | Runtime selectors and Hook security | 2 HIGH fixed / 1 HIGH superseded / 5 MEDIUM fixed / 2 MEDIUM residual / 2 LOW fixed |
| 2026-07-31 | `REVIEW_205_internal-compatibility-pruning.md` | Second-pass internal compatibility pruning | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed / 3 LOW fixed |
| 2026-07-31 | `REVIEW_204_compatibility-cleanup.md` | Current-only compatibility cutover and codebase slimming | 0 CRITICAL / 1 HIGH fixed / 5 MEDIUM fixed / 2 LOW fixed |
| 2026-07-31 | `REVIEW_203_hook-config-and-development-navigation-safety.md` | Hook ownership and renderer reload safety | 0 CRITICAL / 3 HIGH fixed / 1 MEDIUM fixed |
