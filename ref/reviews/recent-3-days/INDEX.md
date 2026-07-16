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
| 2026-07-15 | `REVIEW_163_checkpoint-patch-reduction.md` | Deterministic checkpoint patch reduction | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-07-15 | `REVIEW_162_runtime-log-signal-and-recovery.md` | Runtime log signal, checkpoint recovery, and navigation containment | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW fixed |
| 2026-07-14 | `REVIEW_161_handoff-ownership-plan-review-hardening.md` | Current-owner authority and plan-review lifecycle | 0 CRITICAL / 5 HIGH fixed / 13 MEDIUM fixed / 5 LOW fixed |
| 2026-07-14 | `REVIEW_160_checkpoint-lifecycle.md` | Automatic bounded continuation checkpoints | 0 CRITICAL / 3 HIGH fixed / 5 MEDIUM fixed / 6 LOW fixed |
| 2026-07-14 | `REVIEW_159_present-plan-lifecycle.md` | Blocking plan gate and isolated review fork | 0 CRITICAL / 0 HIGH / 5 MEDIUM fixed / 1 LOW fixed |
| 2026-07-14 | `REVIEW_158_handoff-context-coverage.md` | Runtime persistence and hand-off context coverage | 0 CRITICAL / 1 HIGH fixed / 2 MEDIUM fixed / 1 LOW residual |
| 2026-07-13 | `REVIEW_157_codex-first-model-event-watchdog.md` | Codex accepted-turn recovery | 0 CRITICAL / 3 HIGH fixed / 1 MEDIUM fixed / 1 LOW fixed + 3 residuals |
| 2026-07-12 | `REVIEW_156_codex-mcp-synchronized-readiness.md` | Synchronized Codex MCP readiness isolation | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
| 2026-07-12 | `REVIEW_155_handoff-cutover-continuity.md` | Message-safe session handoff cutover | 0 CRITICAL / 7 HIGH fixed / 6 MEDIUM fixed / 2 LOW fixed |
| 2026-07-12 | `REVIEW_154_core-snapshot-ui-copy.md` | Core snapshot integrity and concise UI copy | 0 CRITICAL / 1 HIGH fixed / 4 MEDIUM fixed / 3 LOW fixed |
| 2026-07-12 | `REVIEW_153_storage-maintenance-worker-provider-compaction.md` | Dedicated storage worker and provider compact runtime | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
