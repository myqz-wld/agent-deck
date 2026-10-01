# Agent Deck

A desktop workspace for Claude Code, Codex CLI, and Grok Build.
Manage agent sessions, project work, and collaboration in one place.

## Features

- Live sessions, searchable history, context and usage tracking.
- Codex quota-reset counts from usage reads, with confirmed redemption and safe retries.
- Teammates, tasks, issues, reviews, and session handoffs.
- Unified `ask_user` questions from Claude, Codex, and Grok in Pending, with choices, free text, and notes.
- Markdown, images, and inline file diffs.
- Readable file and command output with expandable raw tool results.
- Git worktree isolation and provider-native runtime controls.
- Bundled Agents, Skills, and session-owned Browser tabs.
- Local projects and remote workspaces through Full or Relay deployments.
- Feishu chat with rich text input, progress reactions, named work sessions, saved choices, and approvals.
  Remote host settings configure only the Feishu assistant; work sessions choose options during
  creation and remember their own last selection, independently of Desktop. Assistant settings
  prefill remote new-session defaults and share editable model/Gateway controls with summary and
  continuation settings. Gateway changes load their own defaults and remember explicit thinking
  choices. The assistant section collapses and remembers its expanded state. Selections save
  immediately, including while collapsed; model text saves on blur or Enter. Remote settings, assets,
  and session detail views retain bounded read caches and revalidate on return, with a 150 ms
  loading grace. The quota page keeps its explicit refresh button and existing totals during reads.

## Quick Start

Requires Node.js and pnpm. Authenticate the providers you want to use through their CLI workflows.

```bash
pnpm install
pnpm dev
```

Open a project, start a session, and describe the task.

When an agent needs clarification or a choice, `ask_user` places up to four related questions in
Pending for the current session, including Remote sessions. Open Pending to answer without searching
the conversation. Questions wait without an application timeout while their tool call remains active;
switching sessions or refreshing the UI preserves pending questions. Submission returns the selected
options, free text, and notes to the agent. Unanswered items are explicit empty entries; cancellation,
session closure, or handoff ends the request without treating it as approval. The tool requires
Agent Deck MCP to be enabled; provider-native question mechanisms remain available as a fallback.

New-session thinking defaults follow the selected Gateway configuration, including Claude's
`env.CLAUDE_CODE_EFFORT_LEVEL` and `effortLevel`. Explicit thinking choices are kept separately
for each Gateway; when no valid value is configured, the creation form uses `high`.

The usage panel shows available Codex resets on one compact line. Counts refresh with normal
usage queries; using one requires confirmation and refreshes the provider's allowance afterward.
Simple confirmations share an application dialog, while settings and content viewers retain
their own layouts. Existing sandbox and approval switching rules remain unchanged.

## Development

Bundled providers: Claude Agent SDK `0.3.285`, Codex CLI `0.159.2`, and Grok Build `1.0.44`.
Supporting SDKs: Anthropic `0.129.0`, MCP `1.31.0`, and ACP `1.5.1`.

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check architecture and types |
| `pnpm test` | Run the test suite |
| `pnpm build` | Build the application |
| `pnpm dist:mac` | Build the macOS installer |
| `pnpm install:local:mac --help` | Show local installation options |

Build installers on their target OS. Quit Agent Deck before installation, or explicitly authorize
its controlled shutdown. See the [development workflow](CLAUDE.md) for validation and installation.

## Documentation

Server upgrades check free disk space; accepted Feishu upgrades retain an active and rollback runtime.

- [Runtime configuration](resources/README.md)
- [Relay deployment](deploy/linux/relay/README.snippet.md)
- [Full deployment](deploy/linux/full/README.snippet.md)
- [Feishu gateway](deploy/linux/feishu/README.md)
- [Deployment examples](deploy/examples)
- [Repository workflow](CLAUDE.md) and [Codex instructions](AGENTS.md)
- [Change history](ref/changelogs/INDEX.md)
