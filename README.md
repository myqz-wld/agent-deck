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

### Codex Gateway profiles

Agent Deck discovers Codex Gateways only from
`${CODEX_HOME:-~/.codex}/gateways/*.toml`. The filename stem is the public Gateway id and display
name: `xaminim.toml` appears as `xaminim`. Each file is a complete ordinary Codex configuration,
with the same TOML shape as `config.toml`:

```toml
model = "vendor-model"
model_provider = "vendor-api"
model_reasoning_effort = "high"

[model_providers.vendor-api]
name = "Vendor API"
base_url = "https://example.com/v1"
env_key = "VENDOR_API_KEY"
```

`model`, `model_provider`, and `model_providers` are all optional, just as they are in an ordinary
Codex config. Selecting a Gateway applies the complete parsed TOML at every new, resumed, forked,
or internal thread boundary. When present, its top-level `model_provider` is also passed through the
app-server's native `modelProvider` field so the matching `model_providers` entry is loaded; it does
not need to match the Gateway filename. Agent Deck's own MCP and runtime safety boundaries remain
authoritative. An empty Gateway selection delegates to the ordinary `${CODEX_HOME:-~/.codex}/config.toml`;
a non-empty selection must resolve to its same-named `.toml` file. There is no JSON Gateway format
or legacy provider enumeration. Claude Gateway profiles remain separate under
`~/.claude/gateways/*.json`.

Gateway controls in the app are choice-only: select a discovered filename stem or the empty native
configuration entry; arbitrary text is not accepted. Changing the Gateway while a Codex turn is
active leaves that turn untouched. Agent Deck saves the selection and refreshes the same thread with
the new Gateway configuration through `thread/resume` before the next `turn/start`.

## Basic Workflow

Use a lead session as the control point for the project:

1. Open the project and start a lead session with the agent you prefer.
2. Start teammate sessions for independent tasks or specialist reviews.
3. Follow messages, tasks, issues, and results from the shared workspace.
4. Review proposed plans or diffs and approve them or request revisions.
5. Continue in the current session, hand work to another agent, or finish the task.

Each session keeps its agent's own runtime, permission, approval, and sandbox settings. Agent Deck
coordinates the work without widening access. Codex targets fall back to `never` approval only when
no explicit, resolved, or same-adapter inherited policy exists; remembered selections and the
configured Codex sandbox default remain unchanged.

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
| `pnpm deploy:relay-server -- --config <path> <action>` | Check, deploy, upgrade, roll back, or verify a Relay server |
| `pnpm deploy:relay-worker -- --config <path> <action>` | Check, configure, restart, or verify one isolated local Relay Worker |
| `pnpm deploy:full-server -- --config <path> <action>` | Check, deploy, upgrade, roll back, or verify a Full server |
| `pnpm dist:mac`, `pnpm dist:win`, or `pnpm dist:linux` | Build an installer on the matching host OS |
| `pnpm install:local:mac` | Build, verify, and install the macOS app for local use |

Installer builds contain platform-specific agent runtimes, so cross-platform packaging is not supported.
The local macOS install command replaces the app through a rollback-safe staging bundle, validates
the installed wrapper, and removes the unpacked build copy so Spotlight indexes only the app in
`/Applications`; the DMG remains under `build/dist`.

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
  for Full and Relay appliances; `deploy/linux/manager/` adds static policy
  checks for their host lifecycle manager, and `deploy/linux/feishu/` contains the separate
  long-connection gateway service contract.

The preload IPC surface is the current Desktop-local contract. Remote product methods are defined
explicitly in `src/contracts/methods.ts` and pinned to the reachable Desktop product directory, so
local IPC methods do not acquire Remote or Feishu semantics implicitly.

Protocol 2.7 uses canonical `standalone`, `relay`, and `full` topology values plus anonymous
Server-issued connection scopes and immutable grants. Desktop and Feishu both resolve to the exact
Remote Owner Product v1 method policy; their interaction entry points differ without granting one
channel more Core authority than the other. The P3 milestone adds the Electron-owned remote
profile/source adapter, restricted SSH clients and bridges, official Feishu SDK adapters, isolated
headless role bundles, and fail-closed Linux service/package fixtures. The concrete Electron-free
Core/provider runtime and target-Node bundle are packaged and statically checked, but these artifacts
remain a staged implementation rather than a supported remote release: real Ubuntu/EL9 isolation,
signed-package, Relay, Full, Feishu, and end-to-end acceptance evidence is still required. The
existing standalone desktop remains the supported runtime meanwhile.

## Client sources and server deployment topologies

The desktop has two selectable data sources and keeps the same project, session, history, pending,
and runtime pages when switching between them:

The primary workspace navigation is Live, Pending, History, Issues, and Data. Team coordination
continues through sessions and the built-in collaboration tools rather than a separate Team page.
Session details contain Activity, Tasks, Changes, Summary, and Cross-session messages; permission
and sandbox choices remain part of session creation and runtime controls rather than a separate
inspection page.

| Client source | Meaning |
| --- | --- |
| Local | The existing Standalone composition owns data and computation on this machine. No server participates. |
| Remote | A persisted remote profile supplies the same supported page data through restricted SSH. Switching away does not disconnect the remote transport or stop its Core, Worker, or sessions. |

A Remote profile targets one of two server deployment topologies. These are endpoint properties,
not additional client pages. SSH and Feishu are access transports rather than runtime modes:

| Server topology | Data and computation owner | Client effect |
| --- | --- | --- |
| Full | The isolated Linux appliance, including its Server Core component | One or more desktop clients render server-owned state over restricted SSH; Feishu operates the same authoritative sessions through its long connection. Closing a client does not stop the daemon or sessions. |
| Relay | The always-on local Worker | Desktop and Feishu clients still connect through the server, but repositories, providers, session data, and Browser work remain local. The server forwards opaque bounded frames and metadata only; an offline Worker returns `worker_offline` and never falls back to server compute or queues business work. |

Each Relay Worker owns exactly one operator-selected Workspace. Desktop and owner p2p Feishu flows
may choose the root (`.`) or an existing nested directory, but they receive only relative directory
references. Absolute host paths, Worker-private state, provider credentials, topology, and instance
identity remain host-owned; the Core re-resolves every chosen directory under the Workspace before
creating a session. Provider-native sandboxes may narrow this boundary but cannot widen it.

Local and Remote open the same New Session form. Remote obtains the adapter, provider, model,
thinking, permission/session mode, approval, sandbox, and attachment choices from a revisioned Core
descriptor; unavailable choices carry the Core-owned reason instead of falling back to Local.
Remote directory browsing projects canonical Workspace-relative subdirectories only, and initial
images are transferred through the bounded create contract into private Core-owned storage.

Remote Claude and Codex sandbox choices are compiled under the immutable Workspace ceiling: a
broader provider choice can widen access only up to that Workspace, while selected-directory and
read-only choices narrow it further. Provider credentials and mutable state remain in a separate
private projection. Remote Grok uses a Core-owned inference broker and a host-owned Provider-session
container; it is published only when the exact opt-in, independently managed supervisor, pinned OCI
image/runtime, and Core-only credential are all ready. Missing provisioning disables only Grok with
a Core-owned reason. The shipped Full/Relay templates provide that lifecycle, while real rootless-
Podman and signed-package acceptance remain release gates.

The selected source mode and last Remote profile persist independently. Renderer caches,
subscriptions, navigation, and writes are scoped by source/profile/Core generation so a late Local
or Remote response cannot cross the switch boundary. Capabilities unavailable on a remote endpoint
are shown as disabled, hidden, or read-only rather than falling through to Local operations.
Remote Live rows provide the same right-click archive/delete actions as Local, with dormant-session
reactivation negotiated separately for compatible Cores. Runtime choices changed during an active
turn apply to later work, and desktop-created Remote sessions open as soon as their temporary row is
registered before following any provider-assigned canonical session id.
Remote Issues, Data, session totals, token rates, and session-scoped collaboration metadata come
from the selected Core. Remote Settings displays Worker defaults and Hook status as disabled,
read-only controls. The Assets
Library reads only Worker-packaged assets and the bounded Local Agents/Skills snapshot in the
Worker's isolated Provider Home. Remote never edits Worker configuration, assets, or Hooks;
desktop-only window and notification controls remain explicitly labeled as local.

SSH uses pinned host keys, dedicated public-key credentials, forced commands, and no shell, PTY,
agent forwarding, or tunnel surface. The server issues and enrolls each desktop credential in one
operation, producing one private transfer file for the desktop to import. The renderer never asks
for the deployment topology, instance id, SSH private-key path, or `known_hosts` path; those remain
inside the server-issued credential and Electron main process. Feishu enrollment is bound to exact
app, tenant, open-id,
instance, and credential identities. Approval cards default to a 30-minute presentation lifetime;
`0` is the explicit indefinite setting, while Core remains authoritative for whether a request is
still pending.

Initial capacity estimates are operational starting points rather than guarantees:

| Deployment | Small/test starting point | Recommended ordinary use | Storage |
| --- | --- | --- | --- |
| Full | 2 vCPU, 8 GB RAM | 4 vCPU, 16 GB RAM for roughly 2–3 active sessions and Browser use | About 100 GB SSD for ordinary repositories, builds, caches, state, and backups |
| Build-heavy Full | Workload-specific | 8 vCPU, 32 GB RAM or more | Commonly 200 GB SSD or more |
| Relay | 1 vCPU, 1 GB RAM | 1–2 vCPU, 2 GB RAM for more clients and Feishu delivery | 10–20 GB; no repository, provider, Browser-profile, or business-session storage |

The Linux role definitions and their explicit evidence limits are documented in
[`deploy/linux/full/README.snippet.md`](deploy/linux/full/README.snippet.md),
[`deploy/linux/relay/README.snippet.md`](deploy/linux/relay/README.snippet.md), and
[`deploy/linux/feishu/README.md`](deploy/linux/feishu/README.md).

### Deployment automation

Copy only the required examples to the user-level `~/.agent-deck/deploy/` directory outside the
repository, keep that directory at mode `0700` and each file at mode `0600`, then replace every
placeholder and referenced runtime or credential path:

- [`relay-server.config.example.json`](deploy/examples/relay-server.config.example.json)
- [`relay-worker.config.example.json`](deploy/examples/relay-worker.config.example.json)
- [`full-server.config.example.json`](deploy/examples/full-server.config.example.json)

For a first Relay deployment, deploy the server before its local Worker:

```bash
pnpm deploy:relay-server -- --config /absolute/path/relay-server.json --check
pnpm deploy:relay-server -- --config /absolute/path/relay-server.json --dry-run
pnpm deploy:relay-server -- --config /absolute/path/relay-server.json --deploy
pnpm deploy:relay-worker -- --config /absolute/path/relay-worker.json --check
pnpm deploy:relay-worker -- --config /absolute/path/relay-worker.json --deploy
pnpm deploy:relay-worker -- --config /absolute/path/relay-worker.json --verify
```

Full has no separate Worker:

```bash
pnpm deploy:full-server -- --config /absolute/path/full-server.json --check
pnpm deploy:full-server -- --config /absolute/path/full-server.json --dry-run
pnpm deploy:full-server -- --config /absolute/path/full-server.json --deploy
pnpm deploy:full-server -- --config /absolute/path/full-server.json --verify
```

| Target | Supported actions |
| --- | --- |
| Relay Server | `--check`, `--dry-run`, `--deploy`, `--upgrade`, `--rollback`, `--verify` |
| Relay Worker | `--check`, `--dry-run`, `--deploy`, `--upgrade`, `--verify` |
| Full Server | `--check`, `--dry-run`, `--deploy`, `--upgrade`, `--rollback`, `--verify` |

Server release actions require a clean, committed, pushed, upstream-aligned checkout, pinned SSH
host keys, and digest-pinned images. Egress/quota fields attest to independently verified controls;
the scripts do not create those controls. `--verify` may inspect an unmanaged instance but never
adopts it. Keep the Worker Workspace outside this repository; Worker rollback requires reinstalling
the intended signed app. Remote Grok and its Provider supervisor remain optional and separately
managed. See the [Relay](deploy/linux/relay/README.snippet.md) and
[Full](deploy/linux/full/README.snippet.md) deployment contracts for prerequisites and recovery.

## Documentation

Use the focused documents below when you need implementation or maintenance details:

- [CLAUDE.md](CLAUDE.md) — repository workflow and engineering conventions
- [AGENTS.md](AGENTS.md) — Codex entry-point instructions
- [resources/README.md](resources/README.md) — packaged runtime assets and adapter boundaries
- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) — project change history
