# Agent Deck Application Environment Conventions

> Bundled with the app and injected into every Claude Code SDK session.

## Priority And Loading

This file adds the Agent Deck runtime protocol to in-app SDK sessions. SDK safety constraints, user instructions, and project conventions keep their native priority.

- Claude Code preset safety constraints always have the highest priority. This file does not replace them.
- `settingSources: ['user','project','local']` also loads user / project / local `CLAUDE.md`; user conventions in those files take priority over this baseline.
- Per-turn user messages, developer injections, and SDK API instructions keep their native SDK priority. When they conflict with this baseline, follow the higher-priority instruction.
- Internal oneshot sessions with `settingSources: []` receive only the app-injected baseline and do not load user / project / local `CLAUDE.md`.

## Runtime Capabilities

### Teammate Collaboration

Cross-adapter teammate collaboration uses Agent Deck MCP tools. `send_message` is injected into the receiver conversation by the universal-message-watcher; the receiver handles the user-role message directly and does not poll.

### Lead Wait Boundary

After the lead calls `spawn_session` or `send_message`, if the next step depends on a teammate or reviewer reply, record `spawnPromptMessageId` or `messageId`, tell the user that the task was sent, then stop the current turn. Do not use `sleep`, `get_session` loops, or busy-wait polling in the same turn.

The next wire-prefixed teammate reply is injected as a user-role message into this session. Extract `[msg <id>][sid <senderSid>]` and continue from that reply. Only query `get_session.lastEventAt` when the user later asks for status or a skill gives an explicit stuck threshold; then follow the skill's nudge, shutdown, or respawn rule.

### Codex Mid-Turn Steering

Agent Deck Codex teammates support mid-turn steering during an active ordinary turn. User corrections to the Codex teammate's current work are injected directly into that Codex turn; the receiving Codex session should immediately follow the latest instruction instead of treating it as queued input for the next turn.

Steering does not apply to Codex review or compact turns, and it is not a mechanism for waiting on teammate replies. A Claude lead waiting for a Codex reviewer or teammate still follows the Lead Wait Boundary and continues only after seeing the injected wire-prefixed user-role reply.

### Task Progress

Multi-step work, plans, reviews, and cross-session collaboration must track progress with Agent Deck MCP task tools. Do not maintain a separate Claude Code native task list for the same work.

- Create a personal task: `mcp__agent-deck__task_create({ subject, description?, status?, priority?, blocks?, blockedBy?, labels? })`.
- Create a team-bound task: `mcp__agent-deck__task_create({ subject, teamId, ... })`; the caller must be an active member of the team.
- Update status: `mcp__agent-deck__task_update({ taskId, status })`; use only `pending` / `active` / `completed` / `blocked` / `abandoned`.
- List tasks: `mcp__agent-deck__task_list()` returns tasks visible to the caller; `teamIdFilter` limits to one team; `teamIdFilter: 'null-personal'` lists only the caller's personal tasks.
- Use `task_get` / `task_delete` for single-task lookup and deletion; permissions are based on the task's `teamId`.

If `enableAgentDeckMcp: false` makes MCP task tools unavailable, Claude Code native Task tools may record only the current SDK session's local progress. Cross-session state must be written into the plan file or handoff prompt.

### Review Teammate Failure

`simple-review` / `deep-review` must keep a heterogeneous Claude + Codex reviewer pair. If reviewer-codex fails, the lead first calls `shutdown_session` on the failed session, then respawns with `adapter: 'codex-cli'` and `agentName: 'reviewer-codex'`. Do not substitute a second Claude reviewer.

## Plan / Worktree / Handoff

For complex, cross-session, high-risk, or isolated work, write a durable plan before entering a worktree or handing off. The plan path must be absolute and supplied by the caller, project convention, or current workflow; this baseline does not assume a repository archive directory.

The plan must let a successor session continue without reading prior chat history:

- Goal and invariants.
- Confirmed scope, exclusions, and design decisions.
- Current checklist and progress.
- First step for the next session.
- Known risks, validation requirements, and unresolved questions.

When code changes need isolation, create a worktree from an explicit local `baseBranch`. Claude Code may use native worktree capability; when Agent Deck worktree markers or cross-adapter alignment are required, use MCP:

```ts
mcp__agent-deck__enter_worktree({ baseBranch, workBranch?, worktreePath?, worktreeRoot? })
```

After entering the worktree, point read/write commands at the returned `worktreePath`. Before cleanup, confirm changes were merged, moved out, or explicitly abandoned, then call:

```ts
mcp__agent-deck__exit_worktree({ worktreePath?, discardChanges?, deleteBranch? })
```

Use `discardChanges: true` only when the user explicitly wants to abandon uncommitted changes. Use `deleteBranch: true` only after the branch content has been merged, cherry-picked, or explicitly abandoned.

To hand off the current session, start a successor with `hand_off_session`. The `prompt` must include the plan path, temporary context file path, current progress, and next step. The tool transfers the caller's tasks, active team memberships, and worktree marker, then closes the caller after a successful transfer. Use `spawn_session` for parallel subtasks.

For long context, first write `/tmp/<name>.md`, then ask the successor in the `spawn_session` or `hand_off_session` prompt to read that absolute path.

## Agent Deck Universal Team Backend

Agent Deck MCP tools orchestrate sessions, messages, worktrees, tasks, and issues. Teammates call tools under their own SDK session permissions and sandbox; the lead does not approve permissions on their behalf.

Session tools:

- `spawn_session`: starts a parallel SDK session; passing `teamName` creates a shared team and returns `spawnPromptMessageId`.
- `hand_off_session`: starts a successor session and transfers caller resources.
- `send_message`: sends a normal message or a reply with `replyToMessageId`.
- `list_sessions` / `get_session`: read-only session queries.
- `shutdown_session`: marks the session `closed` and stops the live query; it does not delete events, messages, file changes, or summaries.

Worktree tools: `enter_worktree` / `exit_worktree`. Task tools: `task_create` / `task_list` / `task_get` / `task_update` / `task_delete`. Issue tools: `report_issue` / `append_issue_context` / `update_issue_status`.

### Message Anchors

The `spawnPromptMessageId` returned by `spawn_session` is the anchor for the teammate's first reply. After the teammate's first turn completes, it replies with `send_message({ replyToMessageId: spawnPromptMessageId, ... })`; the reply is injected into the lead conversation.

For later rounds, use the `messageId` returned by `send_message` as the reply-chain anchor. The receiver's user message begins with `[msg <id>][sid <senderSid>]`; extract both values and pass the message id back as `replyToMessageId`.

When the lead waits for a teammate reply, follow the Lead Wait Boundary: send the task, stop the current turn, and continue only after the wire-prefixed reply is injected.

### Cross-Session Rescue

After a lead context reset, use `list_sessions({ spawnedByFilter: '<old-lead-session-id>', statusFilter: 'active' })` to recover old reviewers, then send by session id. If caller and target share no active team and `teamId` is omitted, the message is delivered as a teamless DM: it is still written to messages and injected into the receiver conversation, but it does not appear in the team aggregate panel. Passing a non-shared `teamId` is rejected.

When reviewer team membership must persist across rounds, add the new caller back to the old team or respawn the reviewer pair. For a one-off rescue message, teamless DM is acceptable.

### Wire Fallback

If a reviewer agent receives a message without both `[msg <id>][sid <senderSid>]` anchors, it must still deliver results, but the reply must start with:

```text
⚠ NO MSG ANCHOR
```

The reviewer first uses `list_sessions({ statusFilter: 'active' })` to find the lead and shared team. If it cannot identify a unique lead, it leaves the result in the current reviewer session's assistant output so the lead can read it in SessionDetail.

`messageId` is a UUID; `senderSessionId` is an SDK / CLI session id. When parsing the wire prefix, assume only lowercase hex plus hyphens and do not tighten the regex to a version-specific UUID format.

### Dormant Sessions

`dormant` only stops the live query and releases in-memory state; it does not delete the conversation jsonl. The next `send_message` resumes the original session. If the jsonl is missing and triggers `⚠ FRESH SESSION`, close that teammate and respawn; do not rely on the fresh session's old context.

## Issue Reporting

When you find a problem that should be tracked but is outside the current delivery scope, report it with Agent Deck issue tools. Do not turn required work for the current task into an issue.

- `report_issue`: records a follow-up or Agent Deck app bug.
- `append_issue_context`: appends context to an unresolved issue reported by this session.
- `update_issue_status`: mark an issue `resolved` after fixing it, or `open` / `in-progress` when reopening.

Fix in-scope problems immediately when they are easy to fix. Do not report one-off trivial observations.
