---
review_id: 331
reviewed_at: 2026-10-15
baseline_commit: a7ff9c5acae0a89dbf666fca8252bce77ae05eb0
expired: false
---

# Subagent isolation and native work presentation

## Scope and method

The owner reported background Claude child shell commands appearing in the main conversation,
asked whether background task state remains correct, and requested better presentation and
interaction across Claude, Codex, and Grok. The owner explicitly requested local provider source
inspection for Codex and Grok.

This is a lead source investigation and bounded Claude repair, not an independent paired review.
The cross-provider interface below is a proposal, not an implemented feature or approved plan.
No provider inference, live task cancellation, application restart, or installation was performed.

Evidence includes installed Claude Agent SDK 0.3.299 declarations, Agent Deck adapters and tests,
the local Codex checkout at `4fd5745e8`, and the local Grok checkout at `f049847c`. External paths
below are relative to their respective checkout roots. Source capabilities still require checking
against the selected bundled runtime before enabling a new control.

The review-expiry helper exited 1 while listing historical coverage. A direct baseline, churn,
commit-count, age, and explicit-expiry audit classified seven of the twelve scoped files as
expired and five as covered. All twelve were inspected regardless of earlier coverage.

```review-scope
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.ts
src/main/adapters/claude-code/sdk-bridge/sdk-message-translate-core.test.ts
src/main/adapters/claude-code/sdk-bridge/background-tasks-core.ts
src/renderer/components/activity-feed/background-task-presentation.ts
src/renderer/components/activity-feed/background-task-presentation.test.tsx
src/renderer/components/activity-feed/rows/background-task-row.tsx
src/main/adapters/codex-cli/app-server/translate-collab.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/translate.ts
src/main/adapters/grok-build/runtime-start.ts
src/main/adapters/grok-build/extension.ts
```

## Finding and repair

MEDIUM: Claude SDK child frames share their parent's stream and session ID. Acceptance tracking
checked `parent_tool_use_id`, but content translation did not. Child assistant/user frames therefore
created ordinary parent tool rows, messages, thinking, and file-change intents; child streaming
frames could also overwrite the parent's current live token-rate estimate and model bucket.

The translator now handles native background lifecycle snapshots independently, then isolates
frames with a non-null `parent_tool_use_id` before parent content and live-rate translation. Child
assistant usage still uses the existing deduplicated billing/reconciliation path. Main-thread
Agent and Bash calls remain visible with both null and omitted parent markers.

The existing task reducer retains start/progress/completed/failed/stopped state independently of a
main-turn result, rejects late progress after completion, and preserves summary/output references.
Renderer tests now exercise both background shell and background subagent rows, including stable
detail expansion while a single row updates from running through completion.

This repair changes parent-feed projection only. It does not add child transcript storage or a
child inspector. Child content and file-change events are no longer projected as ordinary parent
activity. A future inspector must read or retain explicitly owned child records. Previously stored
parent events lack the ownership marker and are not retrospectively deleted or reclassified.

## Current integration gaps and native evidence

| Provider | Current Agent Deck behavior | Native evidence and useful affordances |
|---|---|---|
| Claude | Independent background task rows; child output previously leaked into parent activity. | SDK `task_*` and `background_tasks_changed` provide identity, runs, state, progress, usage and output references. `Query.stopTask` stops one task; `backgroundTasks(toolUseId)` moves a specific foreground task into the background. SDK transcript readers provide a possible child-detail source. |
| Codex | Collaboration actions become ordinary Agent tool start/end rows. A completed spawn/send/wait call is not an authoritative completed child. The foreground notification subscription filters other thread IDs and ends with the turn. | `codex-rs/app-server-protocol/src/protocol/v2/item.rs` exposes `SubAgentActivity`, child thread/path, and `CollabAgentState`. `thread.rs` defines paginated `thread/backgroundTerminals/list` and exact-thread/process `terminate`, registered as experimental in `protocol/common.rs`. |
| Grok | Standard ACP subagent events are unadvertised and ignored. The native extension callback currently projects completion/usage, not native child/task lifecycle. | `crates/codegen/xai-grok-shell/src/extensions/notification.rs` defines `SubagentSpawned`, `SubagentProgress`, `SubagentFinished`, `TaskBackgrounded`, and `BackgroundTasks`; existing native extensions already provide the more direct integration route. |

Codex's `codex-rs/tui/src/app/agent_status_feed.rs` keeps bounded recent child previews, deduplicated
by item identity. `agent_navigation.rs` maintains first-seen order and marks spawned children as
parent-owned for direct instructions. `tui/src/multi_agents.rs` separates child metadata from
tool-call status. These support stable child navigation and read-only inspection without assuming
that a normal user prompt may be submitted directly to a parent-owned child.

Grok's `crates/codegen/xai-grok-pager/src/views/tasks_pane.rs` already combines commands and subagents
in one panel, with distinct variants and actions. Its `app/acp_handler/background.rs` routes shell
output into the task store and handles completion arriving before background registration.
`app/acp_handler/subagent_lifecycle.rs` handles child identity, attempt IDs, replay, and late finishes.

Grok's native shell `extensions/task.rs` provides task list/kill and subagent list/get/cancel, with
typed outcomes that distinguish cancellation from already-finished and not-found targets.
`extensions/subagent_message.rs` supports queueing or steering literal text to an owned active
child, gated by `ActiveAgentMessages` and a live child address. This is a potential provider-specific
control, not proof that all three providers support a uniform Send/Resume operation.

Grok `BackgroundTasks` is a full snapshot, but `truncated: true` explicitly means it is not a complete
membership list. `tokens_used` in child progress describes context usage, not billed token usage.
These fields must not be normalized into an authoritative empty set or added to session billing.

## Proposed presentation

Use an independent horizontal strip directly above the existing composer. The strip reserves
space only while it contains visible subagents or background tasks; an empty strip renders
nothing. Preserve the existing conversation shell, main activity, composer and chat palette.
Each entity gets its own card. Cards follow the pointer freely in both dimensions. Dropping back
inside the strip commits the previewed order; dragging near either edge while inside the strip
scrolls to reach more cards. Wheel input browses
horizontally, and dragging empty strip space also scrolls. Reordering changes presentation only.
The owner removed the outer frame, drag hints, arrow controls and visible horizontal scrollbar.
Cards are 440 CSS pixels wide in the prototype, capped by the available viewport width.

Clicking a card independently toggles its details upward over the conversation. Details do not
replace the main activity page or change the strip/composer geometry. Their height follows the
content, capped at the current visible conversation area's height, with internal scrolling for
longer content. Width follows the corresponding card. Multiple cards can remain expanded.
Task-strip scrolling or starting a card drag collapses all open details. Scrolling inside a detail
panel keeps it expanded.

Dropping outside the strip stops and hides non-terminal work in one gesture; terminal work is
only hidden. Hiding preserves the task record and result. There is no direction lock: diagonal
movement and changing direction during a drag are supported. Vertical closing requires the
pointer to move more than 80 CSS pixels beyond the strip's top or bottom edge before release;
horizontal tolerance remains 28 pixels. The current drop position determines the action, which
is previewed on the moving card. Returning inside the strip cancels the pending close action
and allows sorting; pointer cancellation leaves the task unchanged. The separate Stop button
remains available in expanded details and stops without hiding. The prototype also supports
Delete/Backspace on a focused terminal card.
Suggested Chinese labels are illustrative proposal copy; no product UI strings change in this repair.

- Keep one stable row per native entity and its current attempt. Progress updates that row instead
  of adding repeated Bash/Agent/wait rows or moving it through the main conversation.
- Put child tools under the child; put a child's background shell under that owner. Ordinary
  synchronous tool calls are detail activity, not additional independent background-task counts.
- Show title, provider, state, elapsed time and one latest-activity line by default. Put full command
  arguments, output, result, file changes and usage into the upward detail panel. Preserve expanded state
  and scroll position during updates; load long transcripts on demand with bounded pagination.
- Distinguish a reusable child from an individual run. Completed work does not mean a child is
  closed; a follow-up creates or resumes an attempt without erasing its earlier outcome.
- Show pending approvals and failures prominently. Successful history stays collapsed. Main-turn
  completion leaves background work visible; stale process history becomes unconfirmed until
  reconciled rather than claiming it is still running or inventing success.
- Native children and Agent Deck cross-session collaborators remain distinct owners. A collaborator
  may have an Open session link; its lifecycle is not reduced to a provider child tool call.

## Proposed interactions and implementation order

1. Normalize provider-native identity, parent identity, attempt/generation, status, summary, and
   source evidence. Store child activity with its owner and keep a separate parent projection.
  Use deterministic reducers and bounded retention; no new LLM summarization call is necessary.
2. Implement the conditional horizontal strip, stable cards, result/output details and existing approval
   navigation. Claude uses SDK lifecycle data; Codex needs child observation outside a foreground
   turn subscription; Grok should first consume native extension lifecycle and snapshot data.
3. Add exact-target Stop only where the current runtime exposes a verified control. Keep a pending
   stopping state until the provider reports the outcome; an accepted request is not final success.
   A main-session interrupt must not silently become Stop all children.
4. Add Send instructions / Continue / Run again only after provider-specific semantics are verified
   and product behavior is selected. Default Codex children to inspection; Grok's active-address
   feature is conditional. Do not invent generic Resume for shell processes or completed children.

The production presentation change remains unimplemented. Placement and interactions above reflect
the owner's latest iterative IAB feedback. Before the larger integration, settle initial live
control scope and child-log retention for the shared model, Local/Remote transport, provider
observers and UI tasks.

The intentionally non-final IAB prototype is in `.ref/prototypes/native-work/`. `preview.tsx`
imports the production `SessionDetailShell`, `ActivityRecordsView`, `SessionComposerView`, runtime
fields and metadata components; `preview.css` imports the production global styles. Only
`ExecutionRail.tsx`, `WorkCard.tsx`, `useWorkRailGestures.ts` and their scoped styles introduce the proposed surface. The current/proposed
toggle uses synthetic events with the known provider-specific baseline projections. A local build
inlines these components for a file URL, with an in-memory API stub and no live session mutations.
All three provider demos now offer the requested stop interaction using synthetic state only.
This does not establish a live Codex child-stop route; exact provider controls still require the
capability work described above. Codex's supplementary instructions remain parent-directed.

## Validation

- New regressions failed before the repair: leaked child content/tools, child model-rate overwrite,
  and completed/failed/stopped background outcomes interleaved with parent completion (five failures).
- Focused validation: 61 tests passed in six files, including both other providers' existing contracts.
- `pnpm typecheck` passed architecture checks and both TypeScript projects.
- Full `pnpm test`: 7,425 passed, 6 skipped; 1,181 files passed, 3 skipped.
- `git diff --check` passed. Changed source/test files remain below 500 lines. No review bucket
  moves were needed. Pure bug-fix behavior does not require a README change.
- IAB prototype: built the production presentation components into a local preview and visually
  inspected collapsed and upward-expanded cards. At the observed 1090 by 480 CSS-pixel viewport,
  the earlier 350-pixel cards showed short output at 77.25 pixels high; longer activity
  reached the conversation area's 156.125-pixel height and scrolled internally. Multiple details
  remained independently expanded while the main text and composer geometry stayed unchanged.
- The empty-work example removed the 77-pixel strip completely. Keyboard dismissal removed a
  completed card; the same key left a running card present. IAB horizontal scrolling to 1,158
  pixels closed all open details. Scrolling 61.5 pixels inside a detail left it open. The Stop
  button changed the selected demo task to stopped while retaining all five cards.
- Twenty-one focused simulated pointer tests passed for stop-and-hide outside each edge and on a
  diagonal, terminal dismissal, short-drag cancellation, free two-dimensional movement, sorting
  preview/commit, click suppression, changing drop intent mid-drag, cancelled sorting, and
  scroll-collapse ownership, and both sides of the stricter vertical boundary for running and
  terminal work. The CLI has no native drag command, so real Browser pointer
  dragging and edge auto-scroll were not automated; the prototype remains open for interaction.
- Earlier IAB checks exercised current/proposed switching, all three provider examples, child
  output, and a synthetic single-task stop with updated active counts. The latest checks confirmed
  the retained Stop button in all three provider demos and Codex's parent-directed input action.
  These controls mutate demo state only. Browser console capture
  reported no errors during the latest bounded interactions. The preview tab remains open.

## Residual risk and activation

The screenshot's live provider stream was not replayed; reproduction uses deterministic SDK frames.
The main-process repair requires a rebuilt/restarted development instance or an updated installed
app to take effect. No running Agent Deck process or installed bundle was changed. Native source
inspection proves implementation possibilities at the recorded revisions, not activation in the
currently running app. Packaging, installation, and the cross-provider redesign remain separate work.
