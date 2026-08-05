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
| `pnpm check:architecture` | Enforce Core, protocol, contract, and Relay import boundaries |
| `pnpm typecheck` | Run architecture and TypeScript checks |
| `pnpm test` | Run the test suite |
| `pnpm build` | Build the application |
| `pnpm verify:linux-headless` | Build and statically verify the isolated Linux headless roles |
| `pnpm dist:mac`, `pnpm dist:win`, or `pnpm dist:linux` | Build an installer on the matching host OS |

Installer builds contain platform-specific agent runtimes, so cross-platform packaging is not supported.

### Architecture boundaries

Host-separation work keeps visualization and application behavior behind explicit inward-facing
boundaries:

- `src/contracts/` contains JSON-safe topology, access, capability, client, and method contracts.
- `src/core/` contains host-neutral application ports and may not import Electron or transports. Its
  session-console dispatcher validates bounded cwd-free session projections and opaque project
  references around an authoritative Core-owned project authority.
- `src/protocol/` contains host-neutral framing, bridge admission, and Relay wire contracts.
- `src/composition/` is the outer layer that selects concrete host implementations.
- `src/clients/` contains transport clients; SSH is owned by the Electron host process, not the
  renderer.
- `src/gateways/im/` contains the transport-neutral Feishu session-console gateway, including
  owner-equivalent enrollment, bounded notification delivery, approval cards, and replay fencing;
  `src/gateways/feishu/` supplies the official SDK long-connection and metadata-only persistence
  adapters.
- `src/hosts/` contains the Electron, daemon, restricted SSH bridge, Relay, local Worker, and
  appliance host boundaries. The Electron main process owns remote SSH profiles and children; the
  host-only instance manager plans and executes exact per-instance Full/Relay lifecycle operations
  without exposing them to Core sessions or remote clients.
- `deploy/linux/full/` and `deploy/linux/relay/` contain fail-closed Quadlet/preflight foundations
  for the full Server Core and relay-only appliances; `deploy/linux/manager/` adds static policy
  checks for their host lifecycle manager, and `deploy/linux/feishu/` contains the separate
  long-connection gateway service contract.

The current preload surface remains available while it is migrated in vertical slices. Its complete
invoke-channel ownership is recorded in `src/contracts/current-api-classification.ts`, so new local
IPC methods cannot acquire remote or Feishu semantics implicitly.

Protocol 2.0 adds bounded `session.console.*` and `project.*` methods: Feishu can paginate, select,
create, and inspect runtime state without receiving a workspace path, and the older cwd-bearing
desktop methods are outside the Feishu allowlist. The P3 milestone adds the Electron-owned remote
profile/source adapter, restricted SSH clients and bridges, official Feishu SDK adapters, isolated
headless role bundles, and fail-closed Linux service/package fixtures. These artifacts are still a staged
implementation rather than a supported remote release: the concrete Electron-free Core/provider
runtime module, target-Node native dependencies, and real Ubuntu/EL9 isolation and end-to-end
evidence remain required. The existing standalone desktop remains the supported runtime meanwhile.

## Client sources and server deployment topologies

The desktop has two selectable data sources and keeps the same project, session, history, pending,
and runtime pages when switching between them:

| Client source | Meaning |
| --- | --- |
| Local | The existing Standalone composition owns data and computation on this machine. No server participates. |
| Remote | A persisted remote profile supplies the same supported page data through restricted SSH. Switching away does not disconnect the remote transport or stop its Core, Worker, or sessions. |

A Remote profile targets one of two server deployment topologies. These are endpoint properties,
not additional client pages. SSH and Feishu are access transports rather than runtime modes:

| Server topology | Data and computation owner | Client effect |
| --- | --- | --- |
| Server Core | The isolated Linux appliance | One or more desktop clients render server-owned state over restricted SSH; Feishu operates the same authoritative sessions through its long connection. Closing a client does not stop the daemon or sessions. |
| Relay | The always-on local Worker | Desktop and Feishu clients still connect through the server, but repositories, providers, session data, and Browser work remain local. The server forwards opaque bounded frames and metadata only; an offline Worker returns `worker_offline` and never falls back to server compute or queues business work. |

The selected source mode and last Remote profile persist independently. Renderer caches,
subscriptions, navigation, and writes are scoped by source/profile/Core generation so a late Local
or Remote response cannot cross the switch boundary. Capabilities unavailable on a remote endpoint
are shown as disabled, hidden, or read-only rather than falling through to Local operations.

SSH uses pinned host keys, dedicated public-key credentials, forced commands, and no shell, PTY,
agent forwarding, or tunnel surface. Feishu enrollment is bound to exact app, tenant, open-id,
instance, and credential identities. Approval cards default to a 30-minute presentation lifetime;
`0` is the explicit indefinite setting, while Core remains authoritative for whether a request is
still pending.

Initial capacity estimates are operational starting points rather than guarantees:

| Deployment | Small/test starting point | Recommended ordinary use | Storage |
| --- | --- | --- | --- |
| Server Core | 2 vCPU, 8 GB RAM | 4 vCPU, 16 GB RAM for roughly 2–3 active sessions and Browser use | About 100 GB SSD for ordinary repositories, builds, caches, state, and backups |
| Build-heavy Server Core | Workload-specific | 8 vCPU, 32 GB RAM or more | Commonly 200 GB SSD or more |
| Relay | 1 vCPU, 1 GB RAM | 1–2 vCPU, 2 GB RAM for more clients and Feishu delivery | 10–20 GB; no repository, provider, Browser-profile, or business-session storage |

The Linux role definitions and their explicit evidence limits are documented in
[`deploy/linux/full/README.snippet.md`](deploy/linux/full/README.snippet.md),
[`deploy/linux/relay/README.snippet.md`](deploy/linux/relay/README.snippet.md), and
[`deploy/linux/feishu/README.md`](deploy/linux/feishu/README.md).

## Documentation

Use the focused documents below when you need implementation or maintenance details:

- [CLAUDE.md](CLAUDE.md) — repository workflow and engineering conventions
- [AGENTS.md](AGENTS.md) — Codex entry-point instructions
- [resources/README.md](resources/README.md) — packaged runtime assets and adapter boundaries
- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) — project change history
