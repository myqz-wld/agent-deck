# Agent Deck

Agent Deck is a desktop workspace for coordinating Claude Code, Codex CLI, and Grok Build
on the same project. Keep agent sessions, collaboration, reviews, and project state in one place.

## Highlights

- Follow live sessions, revisit history, and track context and provider usage.
- Coordinate teammates, tasks, issues, and session handoffs.
- Review plans and diffs, and isolate changes in Git worktrees.
- Use bundled Agents and Skills from the Assets Library.
- Browse pages in a private session Browser and annotate screenshots.
- Work with local projects or connected remote environments.

## Quick Start

Agent Deck requires Node.js 18+ and pnpm.

```bash
pnpm install
pnpm dev
```

Authenticate the agents you plan to use through their normal CLI workflows. Agent Deck uses
their existing configuration and does not store provider credentials. Bundled runtimes are
selected by default; Settings can point to an external installation.

Open a project, start a session, and describe the task. Add teammates for independent work,
follow their progress, and approve or revise proposed plans and diffs.

## Runtime Configuration

Each session keeps its agent's own model, permissions, approvals, and sandbox settings.
Collaboration does not widen that access. Claude and Codex support native Gateway profiles;
see [runtime configuration](resources/README.md) for setup and adapter differences.

Type `/` in the message composer to discover supported commands.

Browser tabs are private to the session, open in the background by default, and
close with the session or handoff lifecycle. You can capture an annotated PNG into the message composer
when the active runtime accepts image input.

## Remote Work and Deployment

Choose **Local** for this machine or **Remote** for a connected workspace. Switching data
sources does not stop remote sessions, and unsupported remote controls never use local data.

- **Full:** a Linux appliance hosts repositories, providers, and session state.
- **Relay:** an always-on Worker hosts repositories and providers; the server relays traffic.

Use the deployment guides for prerequisites, commands, verification, and rollback. Server
release actions require a clean, committed, pushed, and upstream-aligned checkout.

- [Relay deployment](deploy/linux/relay/README.snippet.md)
- [Full deployment](deploy/linux/full/README.snippet.md)
- [Feishu gateway](deploy/linux/feishu/README.md)
- [Configuration examples](deploy/examples)

## Development

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Run architecture and TypeScript checks |
| `pnpm test` | Run the Electron-compatible test suite |
| `pnpm build` | Build main, preload, and renderer bundles |
| `pnpm dist:mac`, `pnpm dist:win`, `pnpm dist:linux` | Build an installer on the matching host OS |
| `pnpm install:local:mac` | Build, verify, and install the macOS app locally |

Quit Agent Deck before a local install. Build installers on the matching host OS; cross-platform
packaging is not supported. See [CLAUDE.md](CLAUDE.md) for the full development workflow.

## Documentation

- [CLAUDE.md](CLAUDE.md) — repository workflow and engineering conventions
- [AGENTS.md](AGENTS.md) — Codex entry-point instructions
- [resources/README.md](resources/README.md) — packaged runtimes and adapter boundaries
- [deploy/linux/](deploy/linux/) — server and gateway deployment contracts
- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) — project change history
