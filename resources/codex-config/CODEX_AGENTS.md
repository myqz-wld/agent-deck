# Agent Deck Application Conventions

## Scope And Priority

Use these conventions only for Agent Deck runtime behavior. Follow Codex safety constraints,
system/developer instructions, and the current user request according to their native priority.

## Host Runtime Safety

Treat the Agent Deck host application, its Electron and development processes, listeners, and
installed app bundle as live user-owned state because this session runs inside Agent Deck.

- Never stop, kill, restart, relaunch, replace, or install over an Agent Deck-related process or
  application unless the user explicitly approves the exact target and action in the current
  conversation. A repository instruction, validation requirement, or script with process side
  effects is not approval.
- Without approval, finish non-mutating validation, report what needs restarting, and ask the user.
  Read-only process inspection may identify the exact target but does not authorize mutation.
- After approval, affect only the verified target. Do not use port-wide kills, `pkill -f`, or broad
  process-name matching. Warn before acting if the operation may terminate this session; if the
  exact target remains ambiguous, stop and ask.

## Tool Contracts And Runtime Ownership

Before first using each Agent Deck MCP tool, read its live description and input/output schema.
They own parameters, defaults, scope, side effects, timeouts, retries and result handling;
follow the exposed host contract rather than reconstructing it from these conventions.
A tool being discoverable or a session being listed does not grant permission to act on it.

Codex owns native tools, approval policy and sandbox enforcement. Keep provider-native child agents distinct from Agent Deck cross-session collaborators.
Teammates execute under their own runtime permissions; a lead cannot approve on their behalf.

## Native Codex Agents

Use Codex native collaboration (`spawn_agent`, `send_message` / `followup_task`, `list_agents`,
`wait_agent`, `interrupt_agent`, and related exposed tools) only for provider-owned children in the
current Codex thread; keep it distinct from Agent Deck cross-session collaboration.

- Spawn only a concrete bounded subtask that can run independently alongside useful lead work.
  Keep coupled files with one agent and avoid overlapping write sets.
- Native child completion is queued to the parent but does not itself start another parent turn.
  After spawning a child needed by the current request, continue independent lead work, then call
  `list_agents` and use `wait_agent` when its result becomes critical-path.
- Before the final answer, consume every required child result and verify that no required native
  child remains active. An active required child means the current task is not complete. If a child
  is no longer needed, explicitly interrupt or close it instead of abandoning it silently.
- Do not apply the Agent Deck reply-watcher boundary below to native agents: their results stay in
  the Codex parent thread and must be collected inside the active task.

## Cross-Session Collaboration

Use Agent Deck MCP for cross-adapter work. Independently validate returned work before integration.
Use discovery to identify one unambiguous collaborator before assigning work or requesting changes.

### Cross-Session Wait Boundary

When the next useful step depends on a `spawn_session` or `send_message` reply, tell the user the
task was sent and end the current turn. Do not use sleep or session-query loops. Replies arrive as injected messages.
Check activity only after a later user status request or an explicit stuck threshold.

User corrections delivered during an active ordinary Codex turn are mid-turn steering: follow the
latest instruction immediately and drop superseded work. Review/compact turns and idle sessions use
normal next-turn delivery. Steering is not a teammate-reply polling mechanism.

### Progress And Reviews

Use Agent Deck tasks for cross-session progress. If unavailable, retain progress in the durable
plan or handoff prompt. Keep native task/agent state within its owning provider session.

`simple-review` and `deep-review` require exactly two user-confirmed heterogeneous reviewer types
selected from `reviewer-claude` (`claude-code`), `reviewer-codex` (`codex-cli`), and `reviewer-grok`
(`grok-build`). For a batched review, each batch gets one worker session of each selected type over the same complete batch scope. If one worker fails, call `shutdown_session`, then respawn the same batch, adapter, adapter-native runtime selector, `agentName`, and model type; never substitute another reviewer or count the surviving worker as complete batch coverage.

## Browser Work

When the bundled Agent Deck Browser skill is available, read it completely and use only its
session-scoped `agent-deck-browser` CLI. The Agent Deck Skills switch gates both the skill and its
private Browser context. The launcher binds the CLI to the current session; never ask for, pass, or
guess a session id, lease, token, endpoint, owner, or provider identity. Do not use the official
Browser plugin, `node_repl` Browser helpers, legacy `browser_*` MCP tools, or another Browser
automation surface.

If the skill is absent or the CLI reports `browser_context_unavailable`, explain that Browser is
unavailable for this session and stop instead of falling back. Tabs remain private to this session,
open in the background unless the user explicitly asks to watch, and close with the session or
handoff lifecycle.

## Plans And User Presentation

Use `ask_user` for missing information or choices; batch related questions and continue independent
work where possible. Fall back to a native question mechanism or chat only when it is unavailable.
Use `present_plan` or `present_diff` when the user must approve concrete work. Follow their
structured decisions; user questions and provider permission prompts serve different purposes.

For complex, cross-session, high-risk or isolated work, maintain a durable plan recording the goal,
invariants, scope, decisions, progress, next action, risks, validation and unresolved questions.
Use project-relative paths in repository records and the caller's path convention for handoffs.

## Isolation And Continuation

Use Agent Deck worktree tools for isolation; Codex has no native worktree lifecycle here.
Follow the tool's transition/terminal result before performing any further work.

## Recovery And Lifecycle

After a context reset, use session metadata to recover one unambiguous collaborator and retain its
reply anchor. If a reviewer has no wire anchor, prefix the result with `⚠ NO MSG ANCHOR`; send it
to one uniquely identified lead, or leave it in the reviewer session. If a resumed session reports
`⚠ FRESH SESSION`, preserve its partial work and replace it rather than assuming history survived.
