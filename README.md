# Agent Deck

Agent Deck is a **multi-Coding-Agent coordinator**. It brings Claude Code, Codex CLI, and Grok Build into one shared workspace and provides a set of **MCP tools for agent collaboration**.

Use it to run agents side by side, let them communicate, track their work, and review important decisions without managing separate terminal windows.

## What It Provides

- **Shared sessions** — see active agents, progress, messages, and results in one place.
- **MCP collaboration tools** — create sessions, form teams, send messages, and coordinate handoffs.
- **Work tracking** — manage tasks and issues across agents.
- **Human review points** — review plans and diffs before work continues; plan Deep Review can keep answering in the background while you switch views, then reopen with its progress and draft preserved.
- **Safe isolation** — use worktrees when changes should stay separate.
- **Multiple runtimes** — Claude Code, Codex CLI, and Grok Build are supported; bundled runtimes are used by default.
- **Native assets** — the Assets Library discovers direct and Plugin Agents/Skills for Claude Code, Codex CLI, and Grok Build as read-only assets; create, edit, delete, install, and enable them through the owning CLI.

## Typical Workflow

1. Start a lead agent session.
2. Add or start teammate sessions for independent work.
3. Let agents coordinate through the MCP tools.
4. Review plans, diffs, tasks, and issues in Agent Deck.
5. Continue, revise, or finish the work from one shared view.

## Quick Start

Requirements: Node.js 18+ and pnpm.

```bash
pnpm install
pnpm dev
```

Authenticate each agent through its normal CLI workflow before first use. Agent Deck uses the agents' local configuration and does not store their credentials.

Leave runtime paths empty to use the app's bundled versions. Configure an external path only when you need a different installation.

## MCP Collaboration Areas

The Agent Deck MCP server provides tools for:

- session creation, control, and handoff;
- messages and team coordination;
- tasks and issue tracking;
- plan and diff review;
- worktree management;
- session-private in-app browser snapshots, bounded waits, interactions, and visual checks.

These tools give agents a shared collaboration environment while keeping each agent's own runtime and permissions intact.

## Development Commands

```bash
pnpm dev         # start development mode
pnpm build       # build the application
pnpm typecheck   # run TypeScript checks
pnpm test:node   # run Node-side tests
pnpm verify:bundled-runtimes  # verify the native Grok package before packaging
pnpm dist        # build an installer; bundled-runtime verification runs first
```

After changing main-process code, restart development mode. Renderer changes can use the development server's hot reload.

## Documentation

- [CLAUDE.md](CLAUDE.md) — repository workflow and engineering conventions
- [AGENTS.md](AGENTS.md) — Codex entry-point instructions
- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) — project change history
