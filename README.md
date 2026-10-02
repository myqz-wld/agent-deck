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

## Development

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check architecture and types |
| `pnpm test` | Run the test suite |
| `pnpm build` | Build the application |
| `pnpm dist:mac` | Build the macOS installer |
| `pnpm install:local:mac --help` | Show local installation options |

Build installers on their target OS. Quit Agent Deck before installation, or explicitly authorize
its controlled shutdown. See the [development workflow](CLAUDE.md) for validation and installation.

## Documentation

- [Runtime configuration](resources/README.md)
- [Relay deployment](deploy/linux/relay/README.snippet.md)
- [Full deployment](deploy/linux/full/README.snippet.md)
- [Feishu gateway](deploy/linux/feishu/README.md)
- [Deployment examples](deploy/examples)
- [Repository workflow](CLAUDE.md) and [Codex instructions](AGENTS.md)
- [Change history](ref/changelogs/INDEX.md)
