# Native work integration evidence

Authoritative plan: [PLAN_97](../PLAN_97_native-work-strip.md).

All observations below came from repository code, installed package declarations, static protocol
generation, or the owner's explicitly requested local provider checkouts. No live inference, task
cancellation, application restart, or database write was used for these spikes.

## S01 — Codex bundled protocol

Question: are the local checkout's task controls present in the currently installed runtime?

Command: `node node_modules/@openai/codex/bin/codex.js app-server generate-ts --out .ref/plans/native-work-strip/codex-protocol --experimental`.
The command exited 0. Its generated `ClientRequest.ts` and v2 declarations include:

- `thread/backgroundTerminals/list`: exact thread, opaque cursor, bounded page size.
- `thread/backgroundTerminals/terminate`: exact thread and process identity; response reports
  `terminated`, so a returned RPC envelope alone must not be treated as success.
- `thread/read`, `thread/turns/list`, `thread/items/list`: metadata and bounded historical reads.
- `turn/interrupt`: exact thread and turn. This can target an owned child's active turn without
  calling the parent session's interrupt path.
- `collabAgentToolCall`: sender/receiver thread IDs and independent `agentsStates`.
- `subAgentActivity`: child thread ID/path, activity kind, model and effort.

`CollabAgentStatus` distinguishes pending initialization, running, interrupted, completed,
errored, shutdown and not-found. `ThreadStatus.idle` is not proof that a reusable child is closed.
The adapter's `app-server/client.ts` already provides generation-scoped `requestLive` and
notification subscriptions. Its foreground `thread.ts` subscription ends with each turn, so
native work observation must have a separate session-owned lifetime.

Remaining risk: static protocol presence is not a live control test. Do not start or revive a
provider process merely to cancel a stale task; check current ownership and process generation.
Experimental methods must remain capability-aware for custom older runtime overrides.
Generated protocol files are non-final spike material, not new first-party source to commit.

## S02 — Claude SDK contract

Installed Agent SDK declarations expose `task_started`, `task_progress`, `task_updated`, terminal
notifications and background-task snapshots. Their run IDs order only within the same task.
`task_started` carries `tool_use_id`, `parent_task_id`, `spawn_depth`, task type and whether the
task is backgrounded. `parent_tool_use_id` identifies child content ownership, not a new parent
conversation event. Build an explicit mapping rather than guessing a native agent ID from text.

`Query.stopTask(taskId)` promises a later stopped notification; request resolution is not that
terminal notification. `listSubagents` and paged `getSubagentMessages` can read native transcripts
under the owning session/project. `getSessionMessages` also supports bounded message reads.
The existing task reducer hides ambient work and keeps state beyond parent turn completion.

Remaining risk: pre-registration child frames require bounded owner-specific buffering, followed
by reconciliation. Do not fall back to projecting unattributed child output into the main feed.
Preserve the existing child billing reconciliation while isolating child activity/context.

## S03 — Grok native extension

Installed package version is 1.0.52. The local Grok source at revision `f049847c` exposes the native
extension wire definitions in `crates/codegen/xai-grok-shell/src/extensions/{notification,task}.rs`.

- `SubagentSpawned/Progress/Finished` carry parent/child identity and optional attempt identity.
  Spawn is emitted on the parent channel before child prompt dispatch.
- `TaskBackgrounded` provides task/tool identity, command, output reference and description.
- `BackgroundTasks` is a full snapshot only when it is not truncated. Missing membership in a
  truncated snapshot must not clear active work or imply a successful outcome.
- `x.ai/task/list` and `x.ai/task/kill` use exact session/task identity.
- `x.ai/subagent/list_running`, `/get` and `/cancel` provide current ownership/state and typed
  cancellation outcomes. The native cancel request contains only a subagent ID, so the Agent Deck
  host must validate parent ownership before dispatch.
- The get response provides `parentSessionId`, `childSessionId`, status, final output, failure
  and cancellation fields. Progress token counts describe context usage, not billed usage.

Current `grok-build/runtime-start.ts` discards other session updates and only translates native
extension completion/usage. Route registered child sessions to child-owned translation state;
retain the existing parent model/usage guards. Native update logs are already used by the
repository's historical usage reader; any child import must stay within the validated runtime
state root and use bounded reads rather than scanning unrelated sessions.

Remaining risk: installed package version does not prove every local-source extension behavior.
Use runtime capability evidence and typed method-not-found handling, with fixture coverage of
older and current envelopes. Never substitute process-name or PID-wide termination.

## S04 — Persistence and history consumers

`src/main/store/schema.ts` declares schema version 62. `db.ts` rejects older versions and changed
schema fingerprints; `schema.sql` describes a current-only baseline, not an upgrade migration
chain. Adding a table or index would therefore change a data-compatibility boundary. A viable
non-destructive candidate is to retain native work envelopes in the existing `events` table,
whose payload is JSON and whose session foreign key already cascades on deletion.

`event-repo.ts` deduplicates ordinary tool calls using parent session/tool identity. Child tools
must have their own task/run/source identity, not reuse that parent key. `safeStringifyPayload`
and Remote event contracts impose payload limits; long child output needs bounded pages/chunks.
Read/append/replay deduplication and revision updates must use the existing repository conventions.

Local ActivityFeed retains 200 recent events; Remote event pages allow 100. A strip derived only
from those pages would lose long-running work when parent activity pushes its snapshot out.
Task listing must independently reconstruct latest states. Parent activity pagination must filter
child-detail records before applying LIMIT, and continuation/summary consumers must not treat
those records as fresh parent messages or duplicate them into model context.

## S05 — Transport, presentation and scope

Local and Remote detail share `SessionDetailShell`. Use one production strip with host-specific
data/control ports, not independent visual implementations. Remote method registration lives in
`src/contracts/methods.ts`; event reads use Replay capability and existing interrupt mutations
use SessionsWrite. Reuse those authorization boundaries for task history and exact-task stop,
with capability negotiation and session-scoped identity checks.

`MarkdownText` is the existing shared renderer and escapes raw HTML. Reuse it as the task-output
default, with the existing plaintext affordance if needed; do not generate formatted output with
an LLM. Per-client presentation preferences may use the established localStorage namespace,
scoped by host/profile, parent session and native attempt, without storing task output there.

Native subagents may run while their spawning tool waits; native-agent visibility is separate
from whether a shell command was backgrounded. Ordinary synchronous shell calls remain normal
activity. Ambient watchers and Agent Deck cross-session team tasks must not be conflated with
native work. Hook-only external CLI sessions can expose observed records but do not grant an
owned live stop handle. Controls must report that boundary honestly.

## Blindspot checklist for final design

- Main-turn finish, component refresh, runtime death, resume and reconnect do not mean child success.
- A new attempt must not inherit an old attempt's hidden state, pending stop or late terminal event.
- Stop rejection/timeout must obey the selected visibility policy; delayed success must not issue
  another cancellation against a newer attempt.
- Snapshot truncation, reordered terminal/progress events and duplicate replay must be tested.
- Sort/hidden preferences are presentation state; native identity/history remain authoritative.
- Child tool/message deltas must not alter parent billing, context, pending ownership or output rate.
- Full task history must survive hiding and be removed through the existing parent deletion path.
- Markdown output needs safe code blocks, links, long text, errors and empty-state coverage.
- No live host lifecycle or installed-bundle mutation is part of ordinary validation.

## Checkpoint state

Checkpoint A passed after the full structured ask_user result was recovered: D05 restores failed
stops, D06 remembers layout and message expansion per session on this client, and D07 retains
child history with the parent. The owner objected to repeated questioning; do not reopen these
decisions after a context reset. The earlier unanswered/recovery state is superseded.

## S06 — Repeated question / answer recovery investigation

The owner's answer was eventually retrieved intact, including the additional requirement to
remember message expansion. This does not prove that the original interrupted request lost
application data. The lead consumed a pending tool result late and had left its decision ledger
unresolved; that is a confirmed orchestration error, not by itself an application defect.

`src/main/ask-user/service.ts` keeps unresolved questions in memory. A response settles the MCP
promise and emits `ask-question-answered`; abort, parent turn finish, session end and committed
handoff cancel unresolved questions. `continuation-context/event-normalizer.ts` retains these
waiting-for-user events. `ipc/adapters.ts` rejects stale MCP answers explicitly.

The response path currently resolves/removes the pending request before best-effort settled-event
publication, whose errors are swallowed. During implementation, reproduce persistence/publication
failure and answer-versus-interrupt races to establish whether an acknowledged answer can lose
its durable recovery record. Also check Local/Remote equivalence and the downstream continuation
projection. A verified application defect is now explicitly in scope for repair; preserve the
documented cancellation of genuinely unanswered requests and avoid reissuing answered questions.
