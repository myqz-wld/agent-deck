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
- **External CLI visibility** — optional hooks mirror supported session, tool, compaction, and subagent lifecycle events from terminal-run agents; unsupported hook events are simply absent.
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

### New-session defaults

New-session dialogs resolve concrete model and thinking values before creation. Claude Code reads
the selected Gateway plus layered user, project, and local `settings.json` files; Codex reads the
effective `config.toml` through app-server. These controls are collapsed under **Model
configuration** until you need to change them. Clearing the model field omits the override, so the
runtime configuration remains authoritative.

Agent Deck remembers the most recent choices for each adapter during the current app run. Those
choices take precedence when the dialog is reopened. Permission, approval, work-mode, and sandbox
selectors show concrete values and are ordered from the most restrictive option to the most
permissive.

### Codex session approvals

When creating a Codex session—or starting a new Codex session from an issue—choose its thread-wide
approval policy: `untrusted`, `on-request`, or `never`. The initial value is resolved from the
effective Codex configuration (falling back to `on-request`), and Agent Deck forwards the concrete
selection to Codex app-server and preserves it when the session resumes or recovers. The session
page exposes the same strict-to-permissive selector; a change applies to the next turn without
interrupting the response already in progress.

Approval policy and sandbox access are separate. Choosing `never` stops approval prompts but does
not widen filesystem or network access; operations outside the selected sandbox fail instead.
In particular, Codex `workspace-write` intentionally keeps the repository's `.git` metadata
read-only. With `on-request`, a Git write such as staging or committing can request approval to
cross that boundary; with `never`, the same operation fails immediately.

### Grok Build sandbox profiles

Agent Deck can request Grok Build's native `off`, `workspace`, `devbox`, `read-only`, or `strict`
sandbox when creating, handing off, or resolving work in a Grok session. Named custom profiles
from user or project `sandbox.toml` files are also accepted. Existing idle Grok sessions can switch
profiles without changing their Agent Deck or native session identity.

The global setting defaults to `workspace`. All renderer pickers list only `read-only`, `workspace`,
`off`, or a custom profile; legacy unset and `devbox` settings migrate to `workspace`, while
`strict` migrates to `read-only`. Existing session values remain visible through the custom-profile
field. CLI and MCP callers, including
`agent-deck new --adapter grok-build --grok-sandbox strict`, can still request every native profile.
Agent Deck displays the requested profile because organization-managed requirements may override
it. Sandbox constraints and ACP tool-permission decisions remain separate. On macOS, Grok
documents child-network blocking in `read-only` and `strict` as unenforced even though filesystem
isolation still applies.

## MCP Collaboration Areas

The Agent Deck MCP server provides tools for:

- session creation, control, and handoff;
- messages and team coordination;
- tasks and issue tracking;
- plan and diff review;
- worktree management;
- session-private in-app browser snapshots, bounded waits, interactions, and visual checks.

For `spawn_session` and `hand_off_session`, explicit runtime controls win. Omitted controls inherit
the persisted source values only when source and target use the same adapter; cross-adapter targets
use their own defaults. This includes provider/model/thinking plus adapter-owned permission, work
mode, sandbox, writable-root, and Codex approval/network/read-root state. When no inherited or
explicit Codex approval applies, the target defaults to `on-request`.

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

Installer commands are native-host only: run `dist:mac` on macOS, `dist:win` on Windows, and
`dist:linux` on Linux. Each command packages the host architecture and rejects a different target
before building, because the bundled Claude Code, Codex CLI, and Grok Build runtimes contain
platform-specific payloads. Cross-target artifacts are not part of the supported packaging
contract; CI packaging must use a matching OS and architecture.

After changing main-process code, restart development mode. Renderer changes can use the development server's hot reload.

## Documentation

- [CLAUDE.md](CLAUDE.md) — repository workflow and engineering conventions
- [AGENTS.md](AGENTS.md) — Codex entry-point instructions
- [ref/changelogs/INDEX.md](ref/changelogs/INDEX.md) — project change history
