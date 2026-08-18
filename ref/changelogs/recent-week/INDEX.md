# Recent Week Changelogs

## Scope

This bucket contains only changelogs that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `changed_at` is within the last 3 days, inclusive |
| `recent-week` | `changed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `changed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `changed_at` is older than 30 days, or missing a parseable date |

## Index Table

| changed_at | File | Summary (<= 80 chars) |
|---|---|---|
| 2026-08-15 | `CHANGELOG_613_interruptible-reconnect-and-session-readiness.md` | Make Remote reconnect interruptible and finish 150 ms session readiness |
| 2026-08-14 | `CHANGELOG_612_feishu-server-one-click.md` | Add server-managed Feishu lifecycle for Relay and Full |
| 2026-08-13 | `CHANGELOG_611_feishu-p0-surface-cleanup.md` | Remove dormant Team and permission product surfaces |
| 2026-08-13 | `CHANGELOG_610_explicit-ssh-reconnect.md` | Rebuild an exhausted SSH connection on explicit Connect |
| 2026-08-13 | `CHANGELOG_609_remote-settings-local-controls.md` | Keep local controls editable and prevent generator text clipping |
| 2026-08-13 | `CHANGELOG_608_simplified-session-and-team-navigation.md` | Remove Permissions/Team pages and align Remote generator controls |
| 2026-08-13 | `CHANGELOG_607_remote-ui-runtime-convergence.md` | Reuse Local UI and restore Remote summaries/checkpoints |
| 2026-08-13 | `CHANGELOG_606_remote-settings-agent-runtime-sync.md` | Complete Remote settings and built-in Agent runtime parity |
| 2026-08-13 | `CHANGELOG_605_remote-settings-ui-parity.md` | Align Remote Settings groups and simplify read-only copy |
| 2026-08-13 | `CHANGELOG_604_deployment-config-home.md` | Standardize deployment config home and harden Worker restart |
| 2026-08-13 | `CHANGELOG_603_remote-live-create-parity.md` | Align Remote Live controls, session creation, and source form |
| 2026-08-13 | `CHANGELOG_602_remote-read-only-worker-assets.md` | Make Remote config read-only and sync Worker assets |
| 2026-08-12 | `CHANGELOG_601_remote-provider-selector-parity.md` | Align Remote provider selectors with Local |
| 2026-08-12 | `CHANGELOG_600_remote-history-actions-and-directory-create.md` | Align Remote session actions and Workspace creation |
| 2026-08-12 | `CHANGELOG_599_automatic-remote-provider-catalog.md` | Derive Remote provider choices without a manual catalog |
| 2026-08-12 | `CHANGELOG_598_ipc-readiness-state-machine.md` | Make 150 ms IPC readiness complete and identity-safe |
| 2026-08-12 | `CHANGELOG_597_remote-provider-readiness-and-history-parity.md` | Restore Remote quotas and align Local/Remote History |
| 2026-08-12 | `CHANGELOG_596_remote-source-flat-styling.md` | Simplify Remote source styling with flat neutral surfaces |
| 2026-08-12 | `CHANGELOG_595_remote-source-visual-refresh.md` | Refresh Remote source cards with glass styling |
| 2026-08-12 | `CHANGELOG_594_initial-readiness-and-permission-preload.md` | Delay fast async loading fallbacks until needed |
| 2026-08-12 | `CHANGELOG_593_new-session-defaults-and-tab-alignment.md` | Stabilize new-session defaults and compact UI alignment |
| 2026-08-12 | `CHANGELOG_592_remote-full-ui-parity.md` | Complete source-authoritative Remote UI parity |
