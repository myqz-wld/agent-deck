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
| `pnpm dist:mac`, `pnpm dist:win`, or `pnpm dist:linux` | Build an installer on the matching host OS |

Installer builds contain platform-specific agent runtimes, so cross-platform packaging is not supported.

### Architecture boundaries

Host-separation work keeps visualization and application behavior behind explicit inward-facing
boundaries:

- `src/contracts/` contains JSON-safe topology, access, capability, client, and method contracts.
- `src/core/` contains host-neutral application ports and may not import Electron or transports.
- `src/protocol/` contains host-neutral framing, bridge admission, and Relay wire contracts.
- `src/composition/` is the outer layer that selects concrete host implementations.
- `src/clients/` contains transport clients; SSH is owned by the Electron host process, not the
  renderer.
- `src/gateways/im/` contains the transport-neutral Feishu session-console gateway, including
  owner-equivalent enrollment, bounded notification delivery, approval cards, and replay fencing.
- `src/hosts/` contains the Electron, daemon, restricted SSH bridge, Relay, local Worker, and
  appliance host boundaries. Its host-only instance manager plans and executes exact per-instance
  Full/Relay lifecycle operations without exposing them to Core sessions or remote clients.
- `deploy/linux/full/` and `deploy/linux/relay/` contain fail-closed Quadlet/preflight foundations
  for the full Server Core and relay-only appliances; `deploy/linux/manager/` adds static policy
  checks for their host lifecycle manager.

The current preload surface remains available while it is migrated in vertical slices. Its complete
invoke-channel ownership is recorded in `src/contracts/current-api-classification.ts`, so new local
IPC methods cannot acquire remote or Feishu semantics implicitly.

The remote-host directories are an implementation foundation, not a supported deployment claim
yet. The Feishu gateway and Linux instance manager currently use injected ports and deterministic
tests; production SDK/storage adapters, host composition, native Linux packaging, real Ubuntu/EL9
isolation evidence, end-to-end SSH provisioning, and renderer migration remain gated work. Relay
session listing/selection/runtime update and project-based creation also remain fail-closed until
Core exposes cwd-free session projections and opaque project references. The existing standalone
desktop remains the supported runtime during this staged migration.

## Documentation

Use the focused documents below when you need implementation or maintenance details:

- [CLAUDE.md](CLAUDE.md) — repository workflow and engineering conventions
- [AGENTS.md](AGENTS.md) — Codex entry-point instructions
- [resources/README.md](resources/README.md) — packaged runtime assets and adapter boundaries
- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) — project change history
