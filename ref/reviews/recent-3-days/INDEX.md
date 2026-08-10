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
| 2026-08-09 | `REVIEW_220_relay-image-exact-node-runtime.md` | Exact Node path in the Relay image | 0 CRITICAL / 1 HIGH fixed |
| 2026-08-09 | `REVIEW_219_relay-health-startup-gate.md` | Relay health-gated systemd activation | 0 CRITICAL / 2 HIGH fixed / 1 MEDIUM fixed |
| 2026-08-09 | `REVIEW_218_closed-reviewer-runtime-retirement.md` | Closed reviewer runtime retirement | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 LOW fixed |
| 2026-08-09 | `REVIEW_217_remote-parity-finalization.md` | Remote parity residual lifecycle review | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed / 1 LOW fixed / 1 INFO fixed |
| 2026-08-08 | `REVIEW_216_handoff-lifecycle-context-v2.md` | Handoff context and ownership hardening | 0 CRITICAL / all HIGH+MEDIUM fixed / 1 LOW accepted / 6 residuals |
