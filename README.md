# Agent Deck

A desktop workspace for Claude Code, Codex CLI, and Grok Build.
Manage agent sessions, project work, and collaboration in one place.

## Features

- Manage sessions with searchable history and usage tracking.
- Coordinate agents, tasks, reviews, and handoffs.
- View Markdown, images, file diffs, and command output.
- Track compaction, commands, and background tasks in a unified activity timeline.
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

Choose **自动审批** or **不再询问** under **权限**, and set sandbox access separately.
Switching an existing session to **不再询问** or **完全开放** asks for confirmation.
Provider restrictions and remote workspace boundaries still apply.

## Session extensions

Extension switches apply to new sessions by default. Use `/deck-refresh` to refresh supported
components in the current session when its work is idle. Results show which components need a new
session. `/deck-refresh cancel` withdraws a queued refresh without stopping the agent's task.

Compatible Claude gateways can opt into Tool Search with `"env": {"ENABLE_TOOL_SEARCH": "true"}`
in their gateway JSON; start a new session afterward. Codex uses native model capabilities and any
explicitly configured `model_catalog_json` on the runtime host.

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
