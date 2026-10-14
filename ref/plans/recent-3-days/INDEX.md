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
| 2026-10-14 | `PLAN_87_mcp-discovery-and-control.md` | completed | Implement MCP discovery, exact shutdown grants, and first-diff focus | `CHANGELOG_676`, `REVIEW_322` |
| 2026-10-13 | `PLAN_86_mcp-tool-contract-audit.md` | completed | Audit all MCP tool scopes and propose session discovery options | `REVIEW_321_mcp-discovery-and-tool-contracts.md` |
| 2026-10-12 | `PLAN_85_feishu-assistant-recovery.md` | execution-handoff | Restore retained Feishu assistants and activate the local Worker repair | `REVIEW_319_feishu-closed-assistant-recovery.md` |
| 2026-10-12 | `PLAN_84_provider-installation-recovery.md` | execution-handoff | Provider refresh and safe installation with managed services | `CHANGELOG_675`, `REVIEW_318` |
| 2026-10-11 | `PLAN_83_browser-idle-resume.md` | completed | Resume retained Browser contexts after the 24-hour idle close | `REVIEW_317_browser-idle-resume.md` |
