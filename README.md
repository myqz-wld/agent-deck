# Agent Deck

Agent Deck is a desktop workspace for coordinating Claude Code, Codex CLI, and Grok Build on the same project. It keeps agent sessions, collaboration, reviews, and project state in one place.

## Highlights

- Follow live sessions, messages, results, Git branches, and context usage.
- Reactivate closed sessions from History, and attach images from either composer size when the
  selected runtime supports them.
- Start teammates, form teams, assign tasks, and hand work to another session.
- Review plans and diffs before important changes continue.
- Track tasks and issues alongside the sessions doing the work.
- Isolate changes in Git worktrees when parallel work should stay separate.
- Browse installed Agents, Skills, and plugins from the Assets Library.
- Use a private, session-scoped Browser with an in-app view and screenshot annotation.
- Discover and run the slash commands supported by the active adapter from either Local or Remote
  message composers.

## Quick Start

Agent Deck requires Node.js 18+ and pnpm.

```bash
pnpm install
pnpm dev
```

Authenticate Claude Code, Codex CLI, and Grok Build through their normal CLI workflows before creating sessions. Agent Deck uses their existing local configuration and does not store provider credentials.

Bundled runtimes are selected by default. Configure an external runtime only when you need a different installation.

## Basic Workflow

1. Open a project and start a lead session.
2. Create teammate sessions for independent work or specialist checks.
3. Follow progress through messages, tasks, issues, and session results.
4. Approve or revise proposed plans and diffs.
5. Continue in place, hand the work to another agent, or finish the task.

Each session keeps its agent's own model, permission, approval, and sandbox settings. Coordination never widens the access granted to that runtime.

## Runtime Configuration

### Slash Commands

Type `/` in a Local or Remote message composer to discover commands supported by the active
adapter. Click a suggestion or press Tab to complete it, then press Enter to execute it.

Claude Code and Grok Build publish their available commands from their live runtimes. Codex CLI
currently exposes `/clear` and `/compact`: clearing starts a fresh native conversation while keeping
the Agent Deck activity timeline, and compacting uses Codex's native app-server compaction flow.
Unknown slash-prefixed text remains an ordinary message.

### Gateway Profiles

Gateway profiles remain adapter-native:

| Adapter | Gateway configuration |
| --- | --- |
| Claude Code | `~/.claude/gateways/<id>.json`, passed to the SDK session as its settings file |
| Codex CLI | `${CODEX_HOME:-~/.codex}/gateways/<id>.toml`, applied as a complete native Codex configuration |
| Grok Build | No Agent Deck Gateway selector; Grok keeps its native ACP/provider configuration |

For Claude and Codex, the filename stem is the Gateway id and an empty selection delegates to the adapter's normal native configuration. Agent Deck reads these profiles without writing them or carrying a Gateway choice across adapters. See [resources/README.md](resources/README.md) for the exact runtime contracts.

### Browser and In-App View

Interactive sessions can use the bundled `agent-deck-browser` CLI. Browser tabs are private to the session, open in the background by default, and close with the session or handoff lifecycle. The in-app Browser view can capture an annotated PNG into the message composer when the active runtime accepts image input.

## Data Sources and Server Topologies

The desktop supports two data sources:

| Source | Meaning |
| --- | --- |
| Local | Data, repositories, providers, and sessions stay on this machine. |
| Remote | The selected remote profile supplies supported workspace data through restricted SSH. Switching away does not stop its sessions. |

Remote profiles connect to one of two server topologies:

| Topology | Meaning |
| --- | --- |
| Full | An isolated Linux appliance owns Core, repositories, providers, and session state. |
| Relay | An always-on local Worker owns repositories and providers; the server forwards bounded opaque traffic and metadata only. |

Remote capabilities are explicit. Unsupported pages or controls are disabled, hidden, or read-only and never fall back to Local data. SSH uses pinned host keys, dedicated credentials, forced commands, and no general shell, PTY, forwarding, or tunnel surface.

## Development

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the development app |
| `pnpm typecheck` | Run architecture and TypeScript checks |
| `pnpm test` | Run the Electron-compatible test suite |
| `pnpm build` | Build main, preload, and renderer bundles |
| `pnpm logger:check` | Check renderer and main-process logging rules |
| `pnpm verify:linux-headless` | Build and verify isolated Linux headless roles |
| `pnpm dist:mac`, `pnpm dist:win`, `pnpm dist:linux` | Build an installer on the matching host OS |
| `pnpm install:local:mac` | Build, verify, and install the macOS app locally |

Installer builds contain platform-specific agent runtimes, so cross-platform packaging is not supported.

## Server Deployment

Deployment automation is available for Relay Server, Relay Worker, and Full Server:

- [Relay deployment](deploy/linux/relay/README.snippet.md)
- [Full deployment](deploy/linux/full/README.snippet.md)
- [Feishu gateway](deploy/linux/feishu/README.md)
- [Deployment configuration examples](deploy/examples)

Server release actions require a clean, committed, pushed, and upstream-aligned checkout. Follow the linked deployment contract for prerequisites, exact commands, verification, rollback, and credential handling.

## Architecture and Security

- `src/contracts/` defines JSON-safe product and transport contracts.
- `src/core/` contains host-neutral application ports.
- `src/protocol/` contains bridge admission and wire protocols.
- `src/composition/` selects concrete host implementations.
- `src/clients/` contains transport clients.
- `src/hosts/` contains Electron, daemon, SSH bridge, Relay, Worker, and appliance boundaries.

Local IPC methods do not implicitly acquire Remote or Feishu authority. Remote paths remain Workspace-relative, provider credentials stay host-owned, and every selected directory is revalidated beneath its authoritative Workspace.

## Documentation

- [CLAUDE.md](CLAUDE.md) — repository workflow and engineering conventions
- [AGENTS.md](AGENTS.md) — Codex entry-point instructions
- [resources/README.md](resources/README.md) — packaged runtimes and adapter boundaries
- [deploy/linux/](deploy/linux/) — server and gateway deployment contracts
- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) — project change history
