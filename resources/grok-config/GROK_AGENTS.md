# Agent Deck Application Environment Conventions

> Bundled with Agent Deck and supplied to Grok Build through the ACP session profile.

## Priority And Loading

This baseline adds the Agent Deck collaboration protocol. Grok Build safety rules, the current user request, and project instructions keep their native priority.

- The current user request and more specific project instructions override this baseline.
- Project and user Grok instructions continue to load through Grok Build itself.
- Agent Deck supplies this text per session. It does not edit `~/.grok/AGENTS.md`, `~/.grok/config.toml`, or the user's plugins.

## Adapter Capabilities

Agent Deck selects tools and instructions from the authenticated caller session's adapter profile. Do not invent an adapter field to request hidden tools.

- Use only the tools actually exposed in this session.
- If a requested operation is unavailable, explain the missing capability and give the next supported action.
- Grok's native tools remain owned by Grok Build. Agent Deck adds cross-session MCP tools without replacing the native toolset.
- Image input is capability-negotiated. Accept attachments only when the current ACP session advertises image support; otherwise tell the user that upgrading Grok Build may enable it.

## Teammate Collaboration

Cross-adapter collaboration uses Agent Deck MCP tools. `send_message` is pushed into the receiver conversation as a user-role message; do not poll for it.

After calling `spawn_session` or `send_message`, if the next useful step depends on the reply, record `spawnPromptMessageId` or `messageId`, tell the user the task was sent, and end the current turn. Do not busy-wait with session queries.

For a wire-prefixed reply, extract `[msg <id>][sid <senderSid>]` and use the message id as `replyToMessageId` when replying.

## Task Progress

Use Agent Deck MCP task tools for cross-session work:

- `task_create` creates personal or team tasks.
- `task_update` uses only `pending`, `active`, `completed`, `blocked`, or `abandoned`.
- `task_list` and `task_get` inspect progress.
- `task_delete` removes one task when the user requests it.

When these tools are unavailable, keep durable progress in the plan or handoff prompt.

## Review Pair

`simple-review` and `deep-review` use exactly two user-confirmed heterogeneous slots selected from:

- `reviewer-claude` on `claude-code`
- `reviewer-codex` on `codex-cli`
- `reviewer-grok` on `grok-build`

If one selected reviewer fails, shut down that session and respawn the same adapter, provider, agent name, and model slot. Never replace it with an unselected reviewer or duplicate the survivor.

## Plans, Worktrees, And Handoff

For complex or isolated changes, keep a durable plan containing the goal, invariants, scope, exclusions, progress, next action, risks, validation, and unresolved decisions.

Use Agent Deck's worktree tools when the task needs isolation. Work against the returned absolute path because entering a worktree does not change the current process directory.

`hand_off_session` starts a fresh successor with a provider-neutral continuation context. Call it only after source-side preparation is complete and as the final tool action. A successful result containing a successor session id transfers ownership; end the source turn immediately.

## Message Anchors And Recovery

The first teammate reply anchors to `spawnPromptMessageId`; later replies anchor to the latest `messageId`. Teamless direct messages omit `teamId`.

Dormant sessions preserve their native Grok session and resume through ACP `session/load`. If history is unavailable and the session is clearly fresh, report that loss instead of pretending to remember prior evidence.

## Issue Reporting

Fix required in-scope problems directly. Use Agent Deck issue tools only for real follow-up work outside the current delivery scope.
