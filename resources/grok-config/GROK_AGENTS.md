# Agent Deck Application Environment Conventions

> Bundled with Agent Deck and supplied to Grok Build through the ACP session profile.

## Priority And Loading

Use this baseline only for Agent Deck runtime behavior. Grok Build safety rules, the current user
request, and more-specific project or user instructions keep their native priority.

- Grok Build continues to load its own user/project instructions and native plugins.
- Agent Deck supplies this text per session. It does not edit `~/.grok/AGENTS.md`, Grok
  configuration, sandbox profiles, or user plugins.

## Tool Contracts And Runtime Ownership

Use only tools exposed in the current session. Before calling an Agent Deck MCP tool
(`mcp__agent-deck__*`, shortened below), read its live description and input/output schema; those
are the SSOT for fields, defaults, nullability, side effects, time bounds, retries, and result
shapes. This baseline adds sequencing and lifecycle rules, not a second schema.

Grok native tools remain owned by Grok Build. ACP tool permission and the OS sandbox are separate:
permission decides whether a tool may run; the sandbox limits an allowed tool's resources. Target
runtime controls are adapter- and tool-scoped: Claude may accept `permissionMode` and
`claudeCodeSandbox`; Codex may accept `approvalPolicy` and `codexSandbox`; Grok may accept
`sessionMode` and `grokSandbox`. Desktop-local spawn and handoff tools may also expose
`extraAllowWrite` for Claude and Codex; Server Core omits it and enforces the Core Workspace
ceiling. Pass only fields exposed by the live schema; reject incompatible fields instead of
assuming they were ignored. Explicit values win; omitted runtime values inherit only from a
persisted same-adapter source, while cross-adapter targets use target defaults. A `reviewer-*` name
grants no hidden access.

`grokSandbox` requests the ACP child startup profile; it does not attest the effective managed
policy. Built-ins are `off`, `workspace`, `devbox`, `read-only`, and `strict`; custom profiles come
from Grok's user/project sandbox configuration. Managed requirements may override the request.
Image input is capability-negotiated: accept attachments only when the current ACP session advertises
image support, otherwise report the missing capability.

## Cross-Session Collaboration

Use Agent Deck `spawn_session`, `send_message`, session queries, and `shutdown_session` for
cross-adapter collaboration. `send_message` is injected into the receiver as a user-role message by the
universal-message-watcher; the receiver never polls for delivery.

- Call `spawn_session` only for one bounded, independently executable subtask. Include the objective,
  exact scope and non-overlapping write set, exclusions, expected output, validation, and
  stop/report conditions. Keep coupled producer/consumer files together and parallelize only
  independent batches. `spawn_session` non-idempotently starts one parallel target; a duplicate can create another target.
- A Grok caller has no native provider-history fork. Omitted `contextMode` is `fresh`; use
  `hand_off_session` with an explicit continuation prompt when work must survive a boundary.
- Treat `spawnLimits` as recursion/rate guard state, not promised capacity. On a post-creation
  failure, follow `retryValid` and `nextAction`; do not retry while residual state or prerequisites
  remain unresolved.
- Record the returned `sessionId` and only a non-null `spawnPromptMessageId`. A null `spawnPromptMessageId` is not a reply anchor; send a follow-up and use its returned `messageId` when the first reply needs one.

### Lead Wait Boundary

When the next useful step depends on a `spawn_session` or `send_message` reply, tell the user the
task was sent and end the current turn. Do not use sleep or session-query loops. The next
wire-prefixed reply is injected as a new user-role message; extract `[msg <id>][sid <senderSid>]`
and reply with `replyToMessageId: <id>`. Query `get_session.lastEventAt` only after a later status
request or an explicit stuck threshold.

User corrections delivered during an active ordinary Grok turn are mid-turn steering: follow the
latest instruction immediately and drop superseded work. Idle sessions use normal next-turn
delivery. Steering is not a teammate-reply polling mechanism.

### Progress And Reviews

Use Agent Deck tasks as the cross-session progress source. `task_create` creates a personal task or,
with an active `teamId`, a team task. `task_update` accepts only `pending`, `active`, `completed`,
`blocked`, or `abandoned`; `task_list`, `task_get`, and `task_delete` follow task/team ownership. If
MCP tasks are unavailable, keep progress in the durable plan or handoff prompt.

`simple-review` and `deep-review` require exactly two user-confirmed heterogeneous reviewer types
selected from `reviewer-claude` (`claude-code`), `reviewer-codex` (`codex-cli`), and `reviewer-grok`
(`grok-build`). For a batched review, each batch gets one worker session of each selected type over the same complete batch scope. If one worker fails, call `shutdown_session`, then respawn the same batch, adapter, adapter-native runtime selector, `agentName`, and model type; never substitute another reviewer or count the surviving worker as complete batch coverage.

## In-App Browser

When the bundled Agent Deck Browser skill is available, read it completely and use only its
session-scoped `agent-deck-browser` CLI. The Agent Deck Skills switch gates both the skill and its
private Browser context. The launcher binds the CLI to the current session; never ask for, pass, or
guess a session id, lease, token, endpoint, owner, or provider identity. Do not use legacy
`browser_*` MCP tools or another Browser automation surface.

If the skill is absent or the CLI reports `browser_context_unavailable`, explain that Browser is
unavailable for this session and stop instead of falling back. Tabs remain private to this session,
open in the background unless the user explicitly asks to watch, and close with the session or
handoff lifecycle.

## Plans And User Presentation

For complex, cross-session, high-risk, or isolated work, keep a durable plan with the goal,
invariants, scope/exclusions, decisions, progress, next action, risks, validation, and unresolved
questions. Use an absolute path supplied by the caller or project convention.

Use `present_plan` when the user must approve or revise a plan, and continue only after
`decision: "approved"`. Use `present_diff` when concrete PR or merge-conflict content needs the same
gate; revise and re-present after `decision: "revise"`, and stop on `decision: "timeout"`.

## Worktrees

Use Agent Deck `enter_worktree` / `exit_worktree` when isolation or cross-adapter ownership tracking
is required.

- `enter_worktree` requires an explicit Git `startPoint` and creates only a detached worktree.
  Follow the live path domain: Desktop-local tools use local absolute paths and derive an omitted
  path under `<main-repo>/.agent-deck/worktrees`, which requires an exact `.agent-deck/` ignore
  entry; Server Core accepts only Workspace-relative paths and applies its Workspace default.
- `state: "waiting-tool-result"` is durable acceptance, not an immediate cwd change. Do not `cd`,
  edit through the old cwd, or send a follow-up. Agent Deck fences the old turn, switches runtime
  and database cwd, then starts an internal continuation. Follow an error hint; it implies no switch.
- Before normal exit, preserve intended files and make the worktree clean. `exit_worktree` requires the caller's active structured lease; its `waiting-tool-result` restores cwd before cleanup. Preserve a
  cleanup-pending worktree, resolve the reported identity/reference/dirty-state condition, and retry.
- Use `discardChanges: true` only after explicit user authorization to delete dirty tracked or
  untracked files. It never authorizes losing unreachable commits; create a branch or tag first when
  HEAD lacks a durable reference.

## Handoff

Use `hand_off_session` only to replace the current session with a fresh successor. Agent Deck
privately prepends a bounded, provider-neutral Continuation Context to the authoritative `prompt`; pending cwd transitions reject
handoff. A settled worktree lease, tasks, active team memberships, and in-flight message endpoints
move with the committed ownership transfer; historical provenance remains unchanged.

Call handoff only after all source-side preparation, as the final tool action and never in parallel.
Any successful result containing a successor `sessionId` is terminal for the source, even if
`callerClosed` failed or warnings exist: stop immediately and emit at most one acknowledgement line.
Only an error without a successor id leaves the source usable. If the prompt references a context
file, use only a bounded path the successor can read under the live tool and Workspace contract.

## Recovery And Lifecycle

Use `list_sessions` / `get_session` for metadata and `list_session_events` only for normalized
SQLite activity in the allowed ownership/spawn/team relation, never raw provider transcripts.
`shutdown_session` closes the live query but does not delete events, messages, files, or summaries.

After a lead reset, recover active descendants with `spawnedByFilter` and message the unique target.
Omit `teamId` for a teamless DM; it is delivered but does not appear in the team aggregate. If a
reviewer lacks both wire anchors, prefix the result with `⚠ NO MSG ANCHOR`, locate one unique active
lead, and send a teamless or shared-team DM; otherwise leave the result in the reviewer session.
Grok `dormant` sessions retain their native session and resume through ACP `session/load`. If the
provider cannot recover history and the session is fresh, report the loss instead of inventing it.

## Issue Reporting

Fix required in-scope problems directly. Use `report_issue`, `append_issue_context`, and
`update_issue_status` only for material follow-up work outside the current delivery scope.
