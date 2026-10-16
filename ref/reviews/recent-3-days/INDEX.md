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
| 2026-10-15 | `REVIEW_334_native-work-conversation.md` | Inspect child ordering and exact background command association | Lead audit; focused and full regressions passed |
| 2026-10-15 | `REVIEW_333_answer-durability.md` | Persist Local/Core answers before acknowledging submission | 2 MEDIUM fixed; regression-first validation |
| 2026-10-15 | `REVIEW_332_tool-search-fallback-repairs.md` | Repair Codex startup metadata; verify Claude search opt-in | 2 MEDIUM fixed; native fixtures and full validation passed |
| 2026-10-15 | `REVIEW_331_subagent-background-presentation.md` | Isolate Claude child activity and compare native task interfaces | 1 MEDIUM fixed; three-provider presentation proposal |
| 2026-10-15 | `REVIEW_330_tool-search-loading-evidence.md` | Measure native tool loading and eager fallback paths | 4 MEDIUM opportunities; synthetic native request evidence |
| 2026-10-15 | `REVIEW_329_runtime-component-boundaries.md` | Audit refresh, retention, and native discovery boundaries | Lead audit; source and full regression validated |
| 2026-10-14 | `REVIEW_328_claude-unacknowledged-input-loss.md` | Preserve failed Claude input and support explicit resending | 2 HIGH / 1 MEDIUM fixed; full regression passed |
| 2026-10-14 | `REVIEW_327_session-metadata-startup.md` | Stabilize Gateway and context labels during session startup | 1 MEDIUM / 1 LOW fixed; full regression passed |
| 2026-10-14 | `REVIEW_326_claude-background-task-activity.md` | Restore Claude task visibility, correction tracking, and tool pairing | 3 MEDIUM fixed; full regression and build checks passed |
| 2026-10-14 | `REVIEW_325_handoff-dialog-state.md` | Retain handoff drafts and background work across dialog dismissal | 1 MEDIUM / 1 LOW fixed; regression and build checks passed |
| 2026-10-14 | `REVIEW_324_runtime-log-observability.md` | Audit logging privacy, retention, and heartbeat evidence | 3 MEDIUM / 1 LOW fixed; full validation passed |
| 2026-10-14 | `REVIEW_323_claude-input-latency-and-runtime-logs.md` | Diagnose Claude input latency, SSH faults, and server logging gaps | 1 HIGH / 1 MEDIUM fixed; server logging gaps confirmed |
| 2026-10-14 | `REVIEW_322_mcp-handoff-and-control.md` | Repair MCP handoff, pagination, control authority, and contracts | 3 MEDIUM fixed; staged typecheck and full test suite passed |
| 2026-10-13 | `REVIEW_321_mcp-discovery-and-tool-contracts.md` | Audit MCP discovery, target authority, and host contract parity | 3 MEDIUM verified; implementation in REVIEW_322 |
| 2026-10-13 | `REVIEW_320_claude-consecutive-message-interruption.md` | Classify streamed Claude corrections as interruptions and retain busy state | 2 MEDIUM fixed; full regression suite passed |
| 2026-10-12 | `REVIEW_319_feishu-closed-assistant-recovery.md` | Restore deferred Codex assistant recovery before MCP initialization | 1 HIGH / 1 MEDIUM fixed; activation pending |
| 2026-10-12 | `REVIEW_318_macos-installer-managed-services.md` | Pause managed KeepAlive services during local app installation | 1 HIGH / 2 MEDIUM fixed; native and full regression checks passed |
