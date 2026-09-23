# Agent Deck

Agent Deck is a desktop workspace for coordinating Claude Code, Codex CLI, and Grok Build
on the same project. Keep agent sessions, collaboration, reviews, and project state in one place.

## Highlights

- Follow live sessions, revisit history, and track context and provider usage.
- Coordinate teammates, tasks, issues, and session handoffs.
- Review plans and diffs, and isolate changes in Git worktrees.
- Use bundled Agents and Skills from the Assets Library.
- Browse pages in session-owned tabs with shared website logins and annotate screenshots.
- Work with local projects or connected remote environments.

## Quick Start

Install Node.js and pnpm, then start Agent Deck:

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

For ordinary new sessions, explicit model choices and provider configuration take precedence.
When no model is configured, Claude, Codex, and Grok delegate model selection to their CLI.
Grok reads `[models].default` from its native configuration. Remote Grok passes only this default
selector into its isolated CLI and discovers models through the Core-owned inference broker;
Agent Deck does not pin a container model or maintain a separate model list. Remote selectors
must be native model IDs or built-in CLI aliases; custom endpoint profiles stay outside the container.
Periodic summaries and continuation checkpoints keep their separate model settings.

Type `/` in the message composer to discover supported commands.

Browser tabs are private to the session, open in the background by default, and
close with the session or handoff lifecycle. Local and Remote sessions using the same desktop
share one persistent Browser profile: log in to a website once in IAB and later sessions reuse
that login while it remains valid. Persistent cookies and website storage survive app restarts;
website expiry rules and session-only cookies still apply. Logging out or switching accounts on
a website affects other sessions using that profile.
You can capture an annotated PNG into the message composer
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

Bundled provider versions: Claude Agent SDK `0.3.280` (Claude Code `2.1.280`), Codex CLI
`0.156.0`, and Grok `1.0.41`. Supporting libraries use Anthropic SDK `0.128.0` and ACP SDK `1.5.0`.

After updating bundled agent dependencies, rebuild and reinstall Agent Deck to refresh the
app and macOS Worker runtimes. Dependency versions are recorded in [package.json](package.json)
and [pnpm-lock.yaml](pnpm-lock.yaml).

## Documentation

- [CLAUDE.md](CLAUDE.md) — repository workflow and engineering conventions
- [AGENTS.md](AGENTS.md) — Codex entry-point instructions
- [resources/README.md](resources/README.md) — packaged runtimes and adapter boundaries
- [deploy/linux/](deploy/linux/) — server and gateway deployment contracts
- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) — project change history
