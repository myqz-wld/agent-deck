# Recent 3 Days Plans

## Scope

This bucket contains only plans that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `Completed At` or `completed_at` is within the last 3 days, inclusive |
| `recent-week` | `Completed At` or `completed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `Completed At` or `completed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `Completed At` or `completed_at` is older than 30 days, or missing a parseable date |

## Index Table

| Completed At | Plan | Status | Summary | Related Final Record |
|---|---|---|---|---|
| 2026-10-15 | `PLAN_96_tool-search-fallbacks.md` | completed | Repair eager Tool Search paths; preserve native defaults | `CHANGELOG_685`, `REVIEW_332` |
| 2026-10-15 | `PLAN_95_runtime-component-injection.md` | completed | Pin component versions, native refresh, and Pending alignment | `CHANGELOG_684`, `REVIEW_329` |
| 2026-10-14 | `PLAN_93_unified-compaction-status.md` | completed | Unify compaction, commands, and activity; retain system bubbles | `CHANGELOG_681` |
| 2026-10-14 | `PLAN_92_claude-input-recovery.md` | completed | Preserve failed Claude input and provide explicit resending | `REVIEW_328` |
| 2026-10-14 | `PLAN_91_provider-runtime-readme-refresh.md` | execution-handoff | Refresh provider packages and prepare application activation | `CHANGELOG_680` |
| 2026-10-14 | `PLAN_90_runtime-confirmation-parity.md` | completed | Align runtime confirmations and verify the IAB preview | `CHANGELOG_679` |
| 2026-10-14 | `PLAN_89_runtime-log-observability.md` | completed | Implement private runtime diagnostics and bounded Worker logs | `CHANGELOG_678`, `REVIEW_324` |
| 2026-10-14 | `PLAN_88_unified-permission-modes.md` | completed | Unify permission choices and native runtime mappings | `CHANGELOG_677` |
| 2026-10-14 | `PLAN_87_mcp-discovery-and-control.md` | completed | Implement MCP discovery, exact shutdown grants, and first-diff focus | `CHANGELOG_676`, `REVIEW_322` |
| 2026-10-13 | `PLAN_94_claude-message-installation.md` | completed | Archive verified installation of the Claude message repair | `REVIEW_320` |
| 2026-10-13 | `PLAN_86_mcp-tool-contract-audit.md` | completed | Audit all MCP tool scopes and propose session discovery options | `REVIEW_321_mcp-discovery-and-tool-contracts.md` |
| 2026-10-12 | `PLAN_85_feishu-assistant-recovery.md` | execution-handoff | Restore retained Feishu assistants and activate the local Worker repair | `REVIEW_319_feishu-closed-assistant-recovery.md` |
| 2026-10-12 | `PLAN_84_provider-installation-recovery.md` | execution-handoff | Provider refresh and safe installation with managed services | `CHANGELOG_675`, `REVIEW_318` |
