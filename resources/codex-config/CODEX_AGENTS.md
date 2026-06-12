# Agent Deck Application Environment Conventions

> Bundled with the app and injected into every Codex SDK session.

## Priority And Loading

This file adds the Agent Deck runtime protocol to in-app Codex SDK sessions. Codex safety constraints, user instructions, and project conventions keep their native priority.

- Built-in Codex SDK safety constraints, sandbox, approval policy, and system rules always have the highest priority. This file does not replace them.
- Developer messages and per-turn user prompts take priority over this baseline; when they conflict, follow the caller's current instruction.
- User, project, and local Codex `AGENTS.md` files still load through Codex's native AGENTS chain. This baseline is separate Agent Deck session context; when they conflict, follow the more specific and closer caller instruction unless a higher-priority instruction says otherwise.
- Agent Deck injects this file into in-app Codex SDK sessions through app-server `developerInstructions`. It is not appended to or synced into user-level `~/.codex/AGENTS.md`.

## Runtime Capabilities

### Teammate Collaboration

Cross-adapter teammate collaboration uses Agent Deck MCP tools. `send_message` is injected into the receiver conversation by the universal-message-watcher; the receiver handles the user-role message directly and does not poll.

### Codex Wait Boundary

When the lead calls `spawn_session` or `send_message` and the next useful step depends on a teammate or reviewer reply, record `spawnPromptMessageId` or `messageId`, tell the user that the task was sent, then return control instead of polling. Do not use `sleep`, `get_session` loops, or busy-wait polling in the same request.

The next wire-prefixed teammate reply is injected as a user-role message into this thread. Extract `[msg <id>][sid <senderSid>]` and continue from that reply. Only query `get_session.lastEventAt` when the user later asks for status or a skill gives an explicit stuck threshold; then follow the skill's nudge, shutdown, or respawn rule.

### Codex Mid-Turn Steering

Agent Deck injects user corrections sent during an active Codex turn as mid-turn steering into the current turn. When a steer arrives, immediately follow the latest instruction; do not treat it as queued input for the next turn, and do not finish the old goal first.

Steering applies only to active ordinary turns. Review and compact turns cannot be steered. When no turn is active, messages are handled as normal next-turn user input. Steering is not a polling or waiting mechanism for teammate or reviewer replies.

### Task Progress

Use Agent Deck MCP task tools as the cross-session progress source for multi-step work, plans, reviews, and teammate collaboration. Codex has no native task tool.

- `mcp__agent-deck__task_create({ subject, ... })` creates a personal task; include `teamId` for a team task, which requires active team membership.
- `mcp__agent-deck__task_update({ taskId, status })` changes status; use only `pending`, `active`, `completed`, `blocked`, or `abandoned`.
- `mcp__agent-deck__task_list({ teamIdFilter? })` lists visible tasks; pass a team id for one team or `null-personal` for caller-owned personal tasks.
- `mcp__agent-deck__task_get` and `mcp__agent-deck__task_delete` operate on one task; permissions follow the task's `teamId`.

When MCP task tools are unavailable, write progress into the plan file, handoff prompt, or conversation history.

### Review Teammate Failure

`simple-review` / `deep-review` must keep a heterogeneous Claude + Codex reviewer pair. If reviewer-claude fails, the lead first calls `shutdown_session` on the failed session, then respawns with `adapter: 'claude-code'` and `agentName: 'reviewer-claude'`. Do not substitute a second Codex reviewer.

## Plan / Worktree / Handoff

For complex, cross-session, high-risk, or isolated work, write a durable plan before entering a worktree or handing off. The plan path must be absolute and supplied by the caller, project convention, or current workflow; this baseline does not assume any built-in plan directory.

Codex has no native Plan mode. When you have a plan that needs explicit user review before execution, call `mcp__agent-deck__request_plan_review({ plan, title? })`. Proceed only after `decision: "approved"`; if it returns `decision: "revise"`, update the plan using the returned feedback and ask again when needed.

The plan must let a successor session continue without reading prior chat history:

- Goal and invariants.
- Confirmed scope, exclusions, and design decisions.
- Current checklist and progress.
- First step for the next session.
- Known risks, validation requirements, and unresolved questions.

Codex has no native EnterWorktree / ExitWorktree. When code changes need isolation, use Agent Deck MCP to create, mark, and clean up the worktree:

```ts
mcp__agent-deck__enter_worktree({ baseBranch, workBranch?, worktreePath?, worktreeRoot? })
```

`baseBranch` must be a named local branch; the tool resolves `refs/heads/<baseBranch>` and rejects SHAs, tags, remote-only refs, and rev expressions. MCP does not change the Codex SDK cwd. After entering the worktree, use absolute paths or `git -C <worktreePath>`.

Before cleanup, confirm changes were merged, moved out, or explicitly abandoned, then call:

```ts
mcp__agent-deck__exit_worktree({ worktreePath?, discardChanges?, deleteBranch? })
```

Use `discardChanges: true` only when the user explicitly wants to abandon uncommitted changes. Use `deleteBranch: true` only after the branch content has been merged, cherry-picked, or explicitly abandoned.

To hand off the current session, start a successor with `hand_off_session`. The `prompt` must include the plan path, temporary context file path, current progress, and next step. The tool transfers the caller's tasks, active team memberships, and worktree marker, then closes the caller after a successful transfer. Use `spawn_session` for parallel subtasks.

For long context, first write `/tmp/<name>.md`, then ask the successor in the `spawn_session` or `hand_off_session` prompt to read that absolute path with its adapter's normal file-reading method.

## Agent Deck Universal Team Backend

Agent Deck MCP tools orchestrate sessions, messages, worktrees, tasks, and issues. Teammates call tools under their own Codex SDK approval policy, sandbox, and MCP token; the lead does not approve permissions on their behalf.

Session tools:

- `spawn_session`: starts a parallel SDK session; passing `teamName` creates a shared team and returns `spawnPromptMessageId`.
- `hand_off_session`: starts a successor session and transfers caller resources.
- `send_message`: sends a normal message or a reply with `replyToMessageId`.
- `request_plan_review`: shows a markdown plan in Agent Deck's plan review UI and waits for the user's approval or revision feedback.
- `list_sessions` / `get_session`: read-only session queries.
- `shutdown_session`: marks the session `closed` and stops the live query; it does not delete events, messages, file changes, or summaries.

Worktree tools: `enter_worktree` / `exit_worktree`. Task tools: `task_create` / `task_list` / `task_get` / `task_update` / `task_delete`. Issue tools: `report_issue` / `append_issue_context` / `update_issue_status`.

### Message Anchors

The `spawnPromptMessageId` returned by `spawn_session` is the anchor for the teammate's first reply. After the teammate's first turn completes, it replies with `send_message({ replyToMessageId: spawnPromptMessageId, ... })`; the reply is injected into the lead conversation.

For later rounds, use the `messageId` returned by `send_message` as the reply-chain anchor. The receiver's user message begins with `[msg <id>][sid <senderSid>]`; extract both values and pass the message id back as `replyToMessageId`.

When the lead waits for a teammate reply, follow the Codex Wait Boundary.

### Cross-Session Rescue

After a lead context reset, use `list_sessions({ spawnedByFilter: '<old-lead-session-id>', statusFilter: 'active' })` to recover old reviewers, then send by session id. If caller and target share no active team and `teamId` is omitted, the message is delivered as a teamless DM: it is still written to messages and injected into the receiver conversation, but it does not appear in the team aggregate panel. Passing a non-shared `teamId` is rejected.

When reviewer team membership must persist across rounds, add the new caller back to the old team or respawn the reviewer pair. For a one-off rescue message, teamless DM is acceptable.

### Wire Fallback

If a reviewer agent receives a message without both `[msg <id>][sid <senderSid>]` anchors, it must still deliver results, but the reply must start with:

```text
⚠ NO MSG ANCHOR
```

The reviewer first uses `list_sessions({ statusFilter: 'active' })` to find a unique lead and any shared active team. If a unique lead is found, it calls `send_message` with `sessionId` set to that lead, omits `replyToMessageId`, includes `teamId` only for a shared active team, and starts the reply text with the warning. If it cannot identify a unique lead, it leaves the result in the current reviewer session's assistant output so the lead can read it in SessionDetail.

`messageId` is a UUID; `senderSessionId` is an SDK / CLI session id. When parsing the wire prefix, assume only lowercase hex plus hyphens and do not tighten the regex to a version-specific UUID format.

### Dormant Sessions

`dormant` only stops the live query and releases in-memory state; it does not delete the Codex thread jsonl. The next `send_message` restores conversation history through Codex app-server `thread/resume`. If the jsonl is missing and triggers `⚠ FRESH SESSION`, close that teammate and respawn; do not rely on the fresh session's old context.

## Codex App-Server Defaults

Codex teammate spawn uses the app-level default app-server thread options unless the caller passes an explicit override or a same-adapter Codex caller has a persisted sandbox to inherit. Reviewer-codex follows the same `codexSandbox` inheritance and override rules as any other Codex spawn.

- `sandboxMode` follows `codexSandbox`: explicit argument, same-adapter inheritance, then Codex adapter default.
- `approvalPolicy: 'never'`, so SDK sessions do not wait for invisible approvals.
- For reviewer-codex, `networkAccessEnabled: true` and `additionalDirectories: ['~/.claude', '~/.codex', '/tmp']` are injected so reviewers can read required context and temporary files.

MCP `spawn_session` exposes only allowlisted fields such as `codexSandbox`; it cannot override arbitrary `additionalDirectories` or `networkAccessEnabled`. When a file outside the readable scope is needed, copy it into the worktree, repo cwd, `~/.claude`, `~/.codex`, or `/tmp` before passing the scope.

Agent Deck injects `AGENT_DECK_MCP_TOKEN` into every Codex app-server session. The Codex MCP client uses that token to connect to the streamable HTTP MCP server; the server resolves the caller session and fills it into tool handlers automatically. External global tokens allow only read-only capability; session, worktree, task, and issue write tools are rejected.

## Issue Reporting

When you find a problem that should be tracked but is outside the current delivery scope, report it with Agent Deck issue tools. Do not turn required work for the current task into an issue.

- `report_issue`: records a follow-up or Agent Deck app bug.
- `append_issue_context`: appends context to an unresolved issue reported by this session.
- `update_issue_status`: mark an issue `resolved` after fixing it, or `open` / `in-progress` when reopening.

Fix in-scope problems immediately when they are easy to fix. Do not report one-off trivial observations.
