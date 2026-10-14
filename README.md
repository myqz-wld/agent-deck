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

## Session collaboration

`list_sessions` defaults to related active and dormant session metadata. Set `scope: "all"` to
also discover unrelated sessions in the current Agent Deck instance or Core Workspace. Metadata
visibility does not grant access to another session's activity history. Closing an agent's managed
descendants remains direct; closing other live sessions requires a one-time user confirmation in
Pending. Browser automation uses the session-scoped CLI on both Local and Core hosts.

Opening a text change positions the diff viewer at its first changed region.

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
