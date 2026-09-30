# Agent Deck

A desktop workspace for Claude Code, Codex CLI, and Grok Build.
Manage agent sessions, project work, and collaboration in one place.

## Features

- Live sessions, searchable history, context and usage tracking.
- Teammates, tasks, issues, reviews, and session handoffs.
- Markdown, images, and inline file diffs.
- Readable file and command output with expandable raw tool results.
- Git worktree isolation and provider-native runtime controls.
- Bundled Agents, Skills, and session-owned Browser tabs.
- Local projects and remote workspaces through Full or Relay deployments.

## Quick Start

Requires Node.js and pnpm. Authenticate the providers you want to use through their CLI workflows.

```bash
pnpm install
pnpm dev
```

Open a project, start a session, and describe the task.

New-session thinking defaults follow the selected Gateway configuration, including Claude's
`env.CLAUDE_CODE_EFFORT_LEVEL` and `effortLevel`. Explicit thinking choices are kept separately
for each Gateway; when no valid value is configured, the creation form uses `high`.

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

Server upgrades check free disk space; accepted Feishu upgrades retain an active and rollback runtime.

- [Runtime configuration](resources/README.md)
- [Relay deployment](deploy/linux/relay/README.snippet.md)
- [Full deployment](deploy/linux/full/README.snippet.md)
- [Feishu gateway](deploy/linux/feishu/README.md)
- [Deployment examples](deploy/examples)
- [Repository workflow](CLAUDE.md) and [Codex instructions](AGENTS.md)
- [Change history](ref/changelogs/INDEX.md)
