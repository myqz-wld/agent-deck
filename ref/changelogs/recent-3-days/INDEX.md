# Recent 3 Days Changelogs

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
| 2026-08-12 | `CHANGELOG_592_remote-full-ui-parity.md` | Complete source-authoritative Remote UI parity |
| 2026-08-11 | `CHANGELOG_591_remote-transport-ui-convergence.md` | Stabilize Remote transport and align offline/list UI |
| 2026-08-11 | `CHANGELOG_590_remote-session-continuity.md` | Complete Remote continuity and active input |
| 2026-08-11 | `CHANGELOG_589_codex-never-approval-default.md` | Default Codex approvals to never |
| 2026-08-11 | `CHANGELOG_588_remote-worker-ui-authority.md` | Align Remote UI with Core and Worker authority |
| 2026-08-10 | `CHANGELOG_587_remote-token-usage-ingest.md` | Persist Remote token telemetry and recover keyed history |
| 2026-08-10 | `CHANGELOG_586_remote-source-auto-connect.md` | Restore the persisted active Remote connection |
| 2026-08-10 | `CHANGELOG_585_remote-full-page-parity.md` | Align Remote with the Local capability-backed workspace |
| 2026-08-10 | `CHANGELOG_584_linux-deployment-automation.md` | Add managed Relay, Worker, and Full deployment entrypoints |
| 2026-08-10 | `CHANGELOG_583_local-macos-install.md` | Automate rollback-safe local macOS installation |
| 2026-08-09 | `CHANGELOG_582_podman-health-json-argv.md` | Use executable-first Podman health argv |
| 2026-08-09 | `CHANGELOG_581_relay-image-exact-node-runtime.md` | Provision the exact Relay Node runtime in the image |
| 2026-08-09 | `CHANGELOG_580_relay-health-startup-gate.md` | Gate Relay systemd activation on container health |
| 2026-08-09 | `CHANGELOG_579_provider-runtime-dependencies.md` | Refresh packaged Claude, Codex, and Grok runtime dependencies |
| 2026-08-09 | `CHANGELOG_578_remote-parity-finalization.md` | Close handoff, native-fork, and Remote intent residuals |
