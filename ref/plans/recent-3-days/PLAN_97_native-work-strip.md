---
plan_id: 97
completed_at: 2026-10-15
status: completed
---

# Native work strip implementation

Status: implementation and required validation complete; scoped local submission on `feat/native-work-strip`.
Created: 2026-10-15.
Scoping baseline: `e4f4a08c75439be07b342163e78ddac3e1aca08d`.
Owner: lead implementation session; no delegated tasks.
Isolation: existing Agent Deck worktree `agent-deck-01a13fc5-714-mva5e1o5`; regular branch `feat/native-work-strip` preserves the final commit.
The completed date records approval and validated implementation; application activation is separate.

## Goal and confirmed interaction

Implement the owner's accepted IAB design in the real session detail for Claude, Codex and Grok.
The existing prototype is `.ref/prototypes/native-work/`; source investigation and the bounded
Claude parent-feed repair are recorded in `ref/reviews/recent-3-days/REVIEW_331_subagent-background-presentation.md`.

- Preserve the existing conversation header, tabs, activity rendering, and composer.
- Render a separate horizontal work strip above the composer only when visible native work exists.
- One 440-pixel card per native subagent or background task, capped on narrow viewports; match chat
  colors and omit outer frame, permanent hints, arrow controls, and horizontal scrollbar.
- Independent upward details overlay the conversation; natural height capped at the visible chat
  area, with internal scrolling. Strip scrolling or dragging collapses open details.
- Wheel input scrolls horizontally. Cards follow the pointer freely in two dimensions; dropping
  within the strip sorts. Near-edge dragging scrolls to reach other cards.
- Dropping outside closes display. Non-terminal work must also receive an exact-target stop;
  terminal work is only hidden. The separate Stop button stops without hiding.
- Vertical close boundary is more than 80 CSS pixels beyond the strip's top/bottom. Horizontal
  tolerance is 28 pixels. Returning within the boundary cancels closing; cancellation restores order.
- Hiding does not delete task history/results. Sorting does not change execution order or ownership.
- Native provider children remain distinct from Agent Deck cross-session collaborators.
- Task output defaults to Markdown rendering (owner note in the planning-workflow answer).
- Persist message expansion as well as card ordering, hidden state and task-detail expansion.
  Scope preferences to the current client, host/profile and conversation; keep task attempts distinct.

## Decision ledger

| ID | Owner | Decision / impact | Status and evidence |
|---|---|---|---|
| D01 | User | Accepted strip geometry, expansion, gestures and close thresholds | Confirmed by iterative IAB feedback and final acceptance. |
| D02 | User | Output defaults to Markdown rendering | Confirmed in the planning-workflow answer. |
| D03 | User | Cover native work for Claude, Codex and Grok | Confirmed in the original scope; local Codex/Grok source requested. |
| D04 | User | Use complex-work-planning before isolated development | Confirmed through ask_user. |
| D05 | User | Stop failure or timeout restores the card and offers retry | Confirmed by retrieved ask_user answer: recommended option selected. |
| D06 | User | Remember ordering, hidden state and message expansion per session on this client; new attempts reappear | Confirmed by retrieved ask_user answer and note: message expansion must also be remembered per session. |
| D07 | User | Retain child activity/output with the parent session and clean it up when the parent is deleted | Confirmed by retrieved ask_user answer: recommended option selected. |
| D08 | Project | No host runtime restart/install without exact separate approval | Constrained by CLAUDE.md and runtime conventions. |
| D09 | Engineering | Exact identity/generation checks, event deduplication and bounded paging | Constrained by existing provider/host contracts; mechanical implementation. |
| D10 | User | Keep README concise at final submission | Confirmed by follow-up: user-facing behavior and necessary usage only; implementation/validation detail belongs in ref records. |
| D11 | User | Do not repeat resolved decision questions | Confirmed by follow-up; the full D05-D07 result was recovered and recorded. |
| D12 | User | Investigate answer recovery during interruption/continuation and fix any verified application defect in this implementation | Confirmed by follow-up; conditional regression repair, not a redesign of question cancellation. |

## Evidence and current gaps

Detailed spikes and blindspot findings: [Evidence](PLAN_97_native-work-strip-support/evidence.md).

- `src/shared/background-task.ts` already defines normalized task snapshots and terminal states.
- Claude's `sdk-bridge/background-tasks-core.ts` maintains per-task/run lifecycle independently
  of the foreground turn. `parent_tool_use_id` content isolation was repaired in this worktree.
- `activity-feed/background-task-presentation.ts` coalesces snapshots and marks old running
  records unknown after session boundaries. `records-view.tsx` still renders them in the main feed.
- `SessionDetail/index.tsx` uses `ActivityFeed`; `RemoteSessionDetail.tsx` uses remote events and
  `ActivityRecordsView`. Both use `SessionDetailShell` and separate composer components.
- No existing native-task stop/list/detail facade was found in preload, shared control contracts,
  main IPC, or host contracts. Live controls must be wired through owning provider/host boundaries.
- Codex collaboration calls currently render as ordinary Agent tool calls. Its foreground thread
  subscription is turn-scoped; a completed spawn call cannot mean a completed child. Independent
  child observation and exact thread/process controls require integration.
- Grok's extension callback currently handles turn completion and usage; native lifecycle and
  task snapshots are not projected. Local native source already exposes the relevant extensions.
- Native source evidence: local Codex checkout revision `4fd5745e8`, local Grok checkout revision
  `f049847c`, installed Claude Agent SDK declarations. Verify bundled-runtime support before using
  a provider control. Never replace task stop with a main-session interrupt.

## Selected engineering route

Use one provider-neutral native-work model, the existing durable event store, provider-owned
observers/controllers, and a shared Local/Remote presentation. No schema baseline bump, data reset,
new model call, runtime dependency upgrade, or installed-app replacement is part of this route.

Alternatives considered: deriving cards solely from recent activity loses work outside the
200-event Local / 100-event Remote windows; adding dedicated SQL tables would change this
repository's current-only schema baseline; reading native logs only on click does not satisfy
the confirmed retained-history behavior. The selected route avoids these limitations by adding
typed task-specific event queries and bounded durable child records to the existing table.

### Model, history and ownership

- Retain `background-task` snapshots, extending validated ownership/attempt metadata where needed.
  Represent child activity with a distinct typed native-work envelope/event kind so child tool IDs
  cannot collide with parent tool IDs or drive parent turn/context/usage state.
- Identity includes owning application session, adapter, native entity, and attempt/run. Preserve
  native parent-child relationships; synchronous shell calls are not independent background tasks.
  Reusable subagents and their individual attempts remain distinct. Exclude ambient housekeeping.
- Add an injected repository/read model over `events`, with latest-task reads independent of recent
  activity limits and cursor-based detail reads. Reuse parent deletion cascade and revision/spool
  conventions. Deduplicate snapshots and child records by stable provider identity before replay.
- Split long text/output into UTF-8-safe bounded records below the existing 64 KiB field and
  256 KiB payload limits; page reads below existing host response bounds. Do not silently claim
  full history when native input was already truncated or unavailable.
- Filter child-detail records before parent activity LIMIT/pagination. Audit parent continuation,
  summary, lifecycle, context and billing consumers; child display events do not become parent
  messages or duplicate billable usage. Preserve the earlier Claude billing/isolation repair.
- Retained native-work history remains accessible from a distinct section of the existing Tasks
  tab, separate from Agent Deck team tasks. Inspecting it uses the same scoped detail renderer;
  normal card clicks still expand upward over the chat and do not navigate to Activity.

### Provider controls

- Claude: map `tool_use_id`/`parent_tool_use_id` to task/run identity, retain child content under
  that owner, reconcile native transcripts only within the owned project/session, and use
  `Query.stopTask` for an exact live task. Preserve its subsequent terminal notification.
- Codex: observe owned child threads beyond the parent foreground-turn subscription, import
  bounded native items, reconcile child statuses and background terminal lists, and use exact
  child thread/turn interrupt or thread/process termination. Use existing process-generation
  fences and `requestLive`; never start a fresh provider process merely to stop stale work.
- Grok: translate native lifecycle/snapshot extensions and registered child-session events with
  isolated translation state; use exact owned task kill or subagent cancel, honoring typed
  already-finished/not-found outcomes and truncated snapshots.
- All three expose real per-task support/status. Hook-only external sessions and older custom
  runtimes without control support can show observed history but cannot acquire a stop handle
  through a guessed PID, generic parent interrupt, or arbitrary file/RPC request.

### Local/Remote contract and stop behavior

- Add typed native-work list/detail/stop methods through the adapter port, Desktop IPC/preload,
  Core method registry/runtime, Remote client service and renderer source. Reuse existing event
  read and session-write authorization boundaries; clients provide validated task references,
  not raw provider paths or control-plane commands.
- Stop targets the observed attempt and live runtime generation. Duplicate gestures share the
  same pending action. Treat accepted, already-terminal, unsupported, stale, failed and timed-out
  outcomes explicitly; do not mark success just because an RPC returned.
- Drag-out may hide immediately while stop is pending; durable hiding is committed only when
  terminal state is known. Failure/timeout restores the card and offers retry. A later terminal
  update reconciles state without issuing another stop against a resumed attempt.
- The separate Stop button leaves the card displayed. Read-only or unsupported active work is
  kept visible with the reason rather than pretending the stop-and-hide gesture succeeded.
- Reconnect rehydrates state; stale non-terminal history remains unknown until reconciled.
  Main-turn completion and UI unmount do not stop a native-work observer.

### UI and preferences

- Port the approved prototype into production components, retaining its geometry, free dragging,
  sorting, edge scrolling, height cap, collapse-on-scroll and strict closing boundary.
- Use one shared component in Local and Remote SessionDetail; keep the strip loaded independently
  of the selected detail tab. When no visible task remains, remove the strip and its reserved space.
- Use existing `MarkdownText` for task output by default, retaining a plaintext affordance.
  Persist stable message/tool disclosure state for main conversation and child details, as well
  as card expansion/order/hidden state. Do not use streaming text as a preference identity.
- Store only IDs/order/booleans in scoped client preferences, never task output. New attempts
  reappear; old or deleted-session entries can be pruned without deleting retained task history.
- Preserve existing approval controls and source/file/image authorization. Child inspection is
  scoped read-only content; no new direct child messaging or resume/run-again control is added.

### Conditional answer-recovery repair

Reproduce answer submission versus abort/finish/handoff, persistence failure and continuation
recovery in Local and Core. Fix only verified application defects, with regression tests. The
current repeated-question incident is not by itself evidence that the application lost an answer.
Keep valid cancellation of unanswered requests and do not widen tool or session permissions.

No additional model calls are needed for task aggregation, ordering, filtering, or lifecycle
transitions; these are deterministic operations.

## Boundaries and decisions

The interaction above is user-confirmed and must not be re-litigated without new evidence.
Provider support and runtime ownership are engineering constraints, not permission to silently
exclude one of the three providers. Surface concrete unsupported paths before claiming completion.
Stop failure handling, child-detail retention and persistent per-session display preferences are
confirmed in D05-D07. Reuse these decisions rather than asking the same questions after recovery.
No host app restart, process kill, installation, paid inference, push, or live task control
is authorized by this UI implementation request. Any final commit must first inspect repository
author/committer identity and staged privacy, following the owner's submission instructions.

## Workspace and validation state

The existing Claude isolation fix, its regression tests, REVIEW_331 and the original prototype
were preserved. T01-T07 are implemented. T08 passed typecheck, all 7,515 tests (6 skipped), build,
production-component Browser checks and diff/privacy inspection. Detailed evidence and coverage
limits are in [validation](PLAN_97_native-work-strip-support/validation.md). No subagents or
collaborator sessions were created. The original checkout retains its existing dirty repair;
no newer main-checkout commit was present at inspection. This branch is the scoped submission.

## Implementation tasks

All tasks are lead-owned and sequential unless separately authorized for delegation. No workers
or reviewer sessions have been created. Coupled contracts and consumers stay with one owner.
The first implementation task is complex and has a dedicated cold-start record:
[T01 model and history](PLAN_97_native-work-strip-support/tasks/T01-model-history.md).
Detailed remaining write scopes and acceptance checks are in [Remaining tasks](PLAN_97_native-work-strip-support/tasks.md).

| Task | Outcome | Dependencies | Status |
|---|---|---|---|
| T01 | Native-work model, durable history and parent isolation | Approved plan | Complete |
| T02 | Claude observation, child details and exact stop | T01 | Complete |
| T03 | Codex child/terminal observation, details and exact stop | T01 | Complete |
| T04 | Grok native extension observation, details and exact stop | T01 | Complete |
| T05 | Local/Remote native-work data/control transport | T01-T04 | Complete |
| T06 | Approved strip, Markdown output and remembered disclosure/layout | T05 | Complete |
| T07 | Answer-recovery reproduction and any verified bounded repair | Approved plan | Complete; two defects repaired |
| T08 | Integration verification, concise README, records and final submission | T01-T07 | Complete; local branch submission |

## Validation and acceptance

Targeted suites cover ownership across three providers, late progress/terminal order, duplicates,
parent-turn finish with live children, runtime generation changes, replay/import, new attempts,
truncated snapshots, Unicode/large output and deletion cascade. Real-store tests must run through
the repository's Electron test runner and must not mutate the installed runtime or shared binding.

Local/Remote tests verify parsers, grants, session/attempt isolation, stale references, stop errors,
timeouts, reconnects and unavailable controls. UI tests cover all 21 prototype gesture cases plus
async stop-and-hide recovery, independent expansion, hidden-history access, remembered message
disclosure, new-run visibility, empty-strip geometry and default Markdown rendering.

T07 tests must demonstrate an application defect before a fix is claimed. Include durable answer
publication failure and answer-before/after-abort order, and verify retained answers in continuation
materialization. If no defect is reproduced, record the evidence and leave behavior unchanged.

Final required checks: `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check`, file-size and
privacy inspection. IAB verification uses production components with synthetic data and the
session-scoped CLI. Static provider protocol checks and fake transports do not count as live
inference or cancellation tests. Document that coverage boundary and any activation requirement.

## Final plan challenge and checkpoints

- A: passed. Scope, output rendering, stop failure, retention, preferences and README policy are
  confirmed; the recovered response also confirms message-expansion persistence.
- B: passed for current evidence. The current-only DB baseline rules out an unapproved schema
  reset; existing event persistence is viable. The answer-recovery addition was explicitly
  authorized. No paid/live provider action is needed for implementation validation.
- C: passed for this assembled plan. No material user-owned decision remains unresolved. Do not
  reopen earlier questions; report new contradictory evidence before changing a confirmed policy.
- Assembled-plan approval: `present_plan` returned `decision: approved`. Proceed to isolation and
  implementation without asking for the same plan or D01-D12 again.
- Lead challenge: recent-history eviction, stale attempt controls, owner ambiguity, child-context
  leakage, optimistic-hide failure, message preference collisions, output limits, unavailable
  native history and schema compatibility are addressed above and in acceptance tests. This is
  a lead planning check, not an independent paired review.

## Isolation, rollback and cold start

Agent Deck's worktree transition completed at the scoping baseline above. The active worktree is
`agent-deck-01a13fc5-714-mva5e1o5`; source changes and the approved plan/prototype were imported
through a scoped manifest and patch. Bootstrap verified file hashes and patch application; the
import contains four tracked-file patches and sixteen preserved files. `git diff --check` passed.
Do not re-enter isolation or rerun the completed bootstrap.

The worktree's `node_modules` link shares existing dependencies with the main checkout. Reuse them
without install/postinstall or native-binding rebuilds. Run real-store tests through the existing
Electron harness. Regenerate static protocol scratch only if needed; it was not imported.

This archived plan and its support files are authoritative. The corresponding isolated `.ref/`
plan copies and carry files are removed after archival verification. The prototype remains an
intentionally non-final fixture under `.ref/prototypes/native-work/`. Recovery copies remain in
the original checkout; do not modify unrelated work there.

The approved implementation handoff was consumed. All D01-D12 decisions were reused without
repeating the interview, re-entering isolation, or delegating work.

Rollback consists of reverting scoped source/UI changes while retaining existing event history;
there is no schema downgrade or data deletion. Stop before any host restart/install and ask for
that exact target/action only after code and validation are complete. Final submission must keep
README short and inspect Git identity and staged content; remote push remains outside scope.

## Next action

Implementation and validation are complete. Preserve the local branch and the open production
preview. The original checkout's pre-existing dirty repair was left untouched; integration must
preserve it. Activating this source in the installed Agent Deck app requires a separately approved
build/install/restart operation against that exact app. No push or runtime mutation is included.
