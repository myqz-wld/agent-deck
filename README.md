# Agent Deck

A desktop workspace for Claude Code, Codex CLI, and Grok Build.
Manage agent sessions, project work, and collaboration in one place.

## Features

- Manage sessions with searchable history and usage tracking.
- Coordinate agents, tasks, reviews, and handoffs.
- View Markdown, images, file diffs, and command output.
- Answer agent questions and handle approvals in one workspace.
- Work with built-in Agents, Skills, and Browser tools.
- Connect local projects, remote workspaces, and Feishu chat.

## Quick Start

Requires Node.js and pnpm. Authenticate the providers you want to use through their CLI workflows.

```bash
pnpm install
pnpm dev
```

Open a project, choose a provider, start a session, and describe the task.
Use Pending to respond when an agent needs your input.

Session creation, live controls, handoff, and Feishu preferences share two permission choices:
**自动审批** uses the provider's native automatic approval mechanism; **不再询问** skips routine
approval prompts. Claude uses `auto` / `bypassPermissions`, Codex uses `on-request` with
`auto_review` / `never`, and Grok uses its native auto / always-approve controls. Provider policy
can still restrict either choice. Sandbox access remains a separate setting.

Planning, question-only, and edit-only presets are absent from these controls. Existing live
sessions keep their native permission state until a new choice is applied. Grok's `read-only`
sandbox keeps project files read-only while allowing its state and temporary directories to be written.

## Session collaboration

`list_sessions` defaults to related active and dormant session metadata. Set `scope: "all"` to
also discover unrelated sessions in the current Agent Deck instance or Core Workspace. Metadata
visibility does not grant access to another session's activity history. Closing an agent's managed
descendants remains direct; closing other live sessions requires a one-time user confirmation in
Pending. Browser automation uses the session-scoped CLI on both Local and Core hosts.

Opening a text change positions the diff viewer at its first changed region.

## Runtime diagnostics

Desktop logs treat successful slow summaries as information, with anonymous correlation IDs;
actual summary failures remain warnings. Expected remote IPC `service_stopped` errors are omitted
from the file log only during application shutdown. SSH heartbeat timeouts include ping write
completion, recent receive age, write queue size, and timer delay without recording traffic.

Headless Core/Worker and Relay diagnostics use timestamped JSON on stderr, retaining approved
metrics, error categories, and anonymous run-scoped identifiers. Repeated records are aggregated
within a minute; the next record reports the suppressed count. Relay logs attachment changes,
heartbeat expiry, and forwarding failures, while healthy heartbeats remain quiet. Unknown provider
messages are fingerprinted rather than copied with potential private content.

For macOS Workers launched by the managed service, stdout and stderr each retain a 10 MiB active
file and three rolling backups (80 MiB total). On first adoption, existing content is preserved in
a separate `.legacy` file outside that limit. Rotation preserves launchd's open file descriptors;
the dependency-free bootstrap also catches and aggregates ESM startup failures. This policy applies
to managed JavaScript log writes; interactive output is unchanged and Linux retention belongs to
the service journal. Updating source alone does not activate these changes in running services.

## Development

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check types |
| `pnpm test` | Run the test suite |
| `pnpm build` | Build the application |
| `pnpm dist:mac` | Build the macOS installer |

See the [development workflow](CLAUDE.md) for validation, packaging, and installation.

## Documentation

- [Configuration](resources/README.md)
- [Remote deployment](deploy/linux/relay/README.snippet.md) and [server deployment](deploy/linux/full/README.snippet.md)
- [Feishu setup](deploy/linux/feishu/README.md)
- [Change history](ref/changelogs/INDEX.md)
