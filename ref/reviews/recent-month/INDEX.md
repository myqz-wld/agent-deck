# Recent Month Reviews

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
| 2026-07-13 | `REVIEW_157_codex-first-model-event-watchdog.md` | Codex accepted-turn recovery | 0 CRITICAL / 3 HIGH fixed / 1 MEDIUM fixed / 1 LOW fixed + 3 residuals |
| 2026-07-12 | `REVIEW_156_codex-mcp-synchronized-readiness.md` | Synchronized Codex MCP readiness isolation | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
| 2026-07-12 | `REVIEW_155_handoff-cutover-continuity.md` | Message-safe session handoff cutover | 0 CRITICAL / 7 HIGH fixed / 6 MEDIUM fixed / 2 LOW fixed |
| 2026-07-12 | `REVIEW_154_core-snapshot-ui-copy.md` | Core snapshot integrity and concise UI copy | 0 CRITICAL / 1 HIGH fixed / 4 MEDIUM fixed / 3 LOW fixed |
| 2026-07-12 | `REVIEW_153_storage-maintenance-worker-provider-compaction.md` | Dedicated storage worker and provider compact runtime | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
| 2026-07-11 | `REVIEW_152_storage-performance-observability-svg-icons.md` | Storage migration, MCP readiness, and SVG icons | 0 CRITICAL / 5 HIGH fixed / 6 MEDIUM fixed / 2 LOW residuals |
| 2026-07-11 | `REVIEW_151_send-message-performance-and-logging.md` | Send latency, storage, and runtime logging | 0 CRITICAL / 1 HIGH tracked / 2 MEDIUM fixed + 1 tracked / 2 LOW dispositioned |
| 2026-07-11 | `REVIEW_150_core-session-integrity.md` | Handoff and spawn session integrity | 1 HIGH fixed / 4 MEDIUM fixed / 1 LOW fixed / 2 dispositioned |
| 2026-07-11 | `REVIEW_149_session-pinning-reviewer-model.md` | Persistent session pinning and Codex reviewer runtime | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-07-11 | `REVIEW_148_unified-continuation-context.md` | Unified Continuation Context implementation | 0 CRITICAL / 4 HIGH fixed / 4 MEDIUM fixed |
| 2026-07-10 | `REVIEW_147_codex-collaboration-raw-events.md` | Codex collaboration raw-event boundary | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed / 1 upstream limitation |
| 2026-07-10 | `REVIEW_146_desktop-ephemeral-codex-hooks.md` | Desktop ephemeral Codex hook boundary | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 1 LOW dispositioned |
| 2026-07-10 | `REVIEW_145_claude-reasoning-usage.md` | Claude reasoning usage and option boundaries | 0 CRITICAL / 1 HIGH fixed / 4 MEDIUM fixed / 1 LOW fixed + 1 dispositioned |
| 2026-07-09 | `REVIEW_144_spawn-session-native-fork-risk.md` | Native fork boundary and rollback review | 0 CRITICAL / 4 HIGH fixed / 5 MEDIUM fixed or dispositioned / 2 LOW fixed |
