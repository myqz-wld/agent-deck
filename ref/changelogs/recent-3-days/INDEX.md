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
| 2026-08-09 | `CHANGELOG_582_podman-health-json-argv.md` | Use executable-first Podman health argv |
| 2026-08-09 | `CHANGELOG_581_relay-image-exact-node-runtime.md` | Provision the exact Relay Node runtime in the image |
| 2026-08-09 | `CHANGELOG_580_relay-health-startup-gate.md` | Gate Relay systemd activation on container health |
| 2026-08-09 | `CHANGELOG_579_provider-runtime-dependencies.md` | Refresh packaged Claude, Codex, and Grok runtime dependencies |
| 2026-08-09 | `CHANGELOG_578_remote-parity-finalization.md` | Close handoff, native-fork, and Remote intent residuals |
| 2026-08-08 | `CHANGELOG_569_workspace-bounded-provider-sandboxes.md` | Compile Remote provider sandboxes under the Workspace ceiling |
| 2026-08-08 | `CHANGELOG_436_handoff-lifecycle-context-v2.md` | Harden handoff context, ownership, and large-capture handling |
| 2026-08-07 | `CHANGELOG_577_remote-core-user-presentations.md` | Reuse Local plan and diff gates for Remote sessions |
| 2026-08-07 | `CHANGELOG_576_remote-desktop-browser-broker.md` | Broker Remote Browser tools through the connected desktop |
| 2026-08-07 | `CHANGELOG_575_remote-core-worktree-lifecycle.md` | Restore automatic Remote worktree cwd transitions |
| 2026-08-07 | `CHANGELOG_574_remote-image-asset-broker.md` | Display Remote image diffs through an opaque Core asset broker |
| 2026-08-07 | `CHANGELOG_573_remote-core-session-collaboration-mcp.md` | Add Core-owned Remote session collaboration MCP tools |
| 2026-08-07 | `CHANGELOG_572_remote-issues-parity.md` | Reuse the shared Issues board through Remote Core |
| 2026-08-07 | `CHANGELOG_571_remote-task-and-activity-parity.md` | Reuse shared Remote task and activity presentations |
| 2026-08-07 | `CHANGELOG_570_remote-summary-and-text-diff-parity.md` | Add Workspace-bounded Remote summaries and text diffs |
| 2026-08-07 | `CHANGELOG_568_remote-new-session-parity.md` | Mirror Local New Session controls through Remote Core |
