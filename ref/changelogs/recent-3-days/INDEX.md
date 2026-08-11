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
| 2026-08-10 | `CHANGELOG_586_remote-source-auto-connect.md` | Restore the persisted active Remote connection |
| 2026-08-10 | `CHANGELOG_585_remote-full-page-parity.md` | Align Remote with the Local capability-backed workspace |
| 2026-08-10 | `CHANGELOG_584_linux-deployment-automation.md` | Add managed Relay, Worker, and Full deployment entrypoints |
| 2026-08-10 | `CHANGELOG_583_local-macos-install.md` | Automate rollback-safe local macOS installation |
| 2026-08-09 | `CHANGELOG_582_podman-health-json-argv.md` | Use executable-first Podman health argv |
| 2026-08-09 | `CHANGELOG_581_relay-image-exact-node-runtime.md` | Provision the exact Relay Node runtime in the image |
| 2026-08-09 | `CHANGELOG_580_relay-health-startup-gate.md` | Gate Relay systemd activation on container health |
| 2026-08-09 | `CHANGELOG_579_provider-runtime-dependencies.md` | Refresh packaged Claude, Codex, and Grok runtime dependencies |
| 2026-08-09 | `CHANGELOG_578_remote-parity-finalization.md` | Close handoff, native-fork, and Remote intent residuals |
| 2026-08-08 | `CHANGELOG_569_workspace-bounded-provider-sandboxes.md` | Compile Remote provider sandboxes under the Workspace ceiling |
| 2026-08-08 | `CHANGELOG_436_handoff-lifecycle-context-v2.md` | Harden handoff context, ownership, and large-capture handling |
