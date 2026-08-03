# Agent Deck

Agent Deck is a desktop workspace for coordinating Claude Code, Codex CLI, and Grok Build on the same project. Use it to run agents in parallel, keep their work visible, and review important decisions without juggling terminal windows.

## Highlights

Use Agent Deck for the parts of multi-agent work that normally spill across separate tools:

- **One workspace** — follow live sessions, messages, results, Git branches, and context usage.
- **Agent collaboration** — start teammates, form teams, exchange messages, and hand work to another session through built-in MCP tools.
- **Human checkpoints** — review plans and diffs, then approve them or request changes.
- **Work tracking** — keep tasks and issues connected to the sessions doing the work.
- **Safe isolation** — move sessions into Git worktrees when changes should stay separate.
- **Agent assets** — inspect available Agents, Skills, and plugins across supported runtimes from the Assets Library.

## Quick Start

Run Agent Deck from source with Node.js 18+ and pnpm:

```bash
pnpm install
pnpm dev
```

Before creating a session, authenticate each agent through its normal CLI workflow. Agent Deck uses the agents' local configuration and does not store their credentials.

Bundled runtimes are selected by default. Configure an external runtime path only when you need a different installation.

## Basic Workflow

Use a lead session as the control point for the project:

1. Open the project and start a lead session with the agent you prefer.
2. Start teammate sessions for independent tasks or specialist reviews.
3. Follow messages, tasks, issues, and results from the shared workspace.
4. Review proposed plans or diffs and approve them or request revisions.
5. Continue in the current session, hand work to another agent, or finish the task.

Each session keeps its agent's own runtime, permission, approval, and sandbox settings. Agent Deck coordinates the work without widening access.

## Development

Use these commands for day-to-day development and validation:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the app in development mode |
| `pnpm typecheck` | Run TypeScript checks |
| `pnpm test` | Run the test suite |
| `pnpm build` | Build the application |
| `pnpm dist:mac`, `pnpm dist:win`, or `pnpm dist:linux` | Build an installer on the matching host OS |

Installer builds contain platform-specific agent runtimes, so cross-platform packaging is not supported.

## Documentation

Use the focused documents below when you need implementation or maintenance details:

- [CLAUDE.md](CLAUDE.md) — repository workflow and engineering conventions
- [AGENTS.md](AGENTS.md) — Codex entry-point instructions
- [resources/README.md](resources/README.md) — packaged runtime assets and adapter boundaries
- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) — project change history
