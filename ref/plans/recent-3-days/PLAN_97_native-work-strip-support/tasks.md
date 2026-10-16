# Remaining implementation tasks

Authoritative plan: [PLAN_97](../PLAN_97_native-work-strip.md).

All tasks are sequential and lead-owned. No delegation is authorized by this record. The plan's
confirmed decisions and validation boundaries apply to every task. Update status and evidence
after each meaningful step; a provider demo or mocked stop is not a live-runtime verification.

## T02 — Claude native work

Dependencies: T01. Status: complete.
Writes: `src/main/adapters/claude-code/` observation, translation, bridge/control types, and tests;
minimal registration through the shared provider port established by T01.
Steps: expose all native subagents and actual background work; map task/run/parent tool identity;
retain child tools/messages separately; keep bounded pre-registration buffering; import authorized
paged child transcripts where necessary; implement exact `Query.stopTask`; reconcile late terminal
updates after parent finish. Preserve child usage reconciliation and ambient filtering.
Done: owned child details and independent task control pass lifecycle/race fixtures without
affecting parent messages, context, pending approvals, rate or billing.

## T03 — Codex native work

Dependencies: T01. Status: complete.
Writes: `src/main/adapters/codex-cli/` session-owned observation/control modules, app-server typed
seams, bridge lifecycle integration and tests.
Steps: derive child ownership from native collab/subagent metadata; keep observation beyond one
foreground turn; reconcile child status and exact background-terminal list pages; import bounded
native items; interrupt the observed child turn or terminate the exact thread/process. Bind every
operation to the current process generation; stop unsupported older methods cleanly.
Done: completed spawn/wait calls never falsely complete a child; parent completion does not end
observation; stale stop cannot hit a resumed attempt or create a new process; owned tool/output
records are durable and task-scoped. Re-run existing generation/cancellation tests.

## T04 — Grok native work

Dependencies: T01. Status: complete.
Writes: `src/main/adapters/grok-build/` native extension translation, child ownership/state,
runtime lifetime integration, exact controls and tests.
Steps: consume native subagent/task notifications and snapshots; route owned child session events
to isolated translation state; preserve attempt IDs, snapshot truncation and terminal ordering;
obtain bounded child/output history from owned runtime sources; use task kill/subagent cancel
with verified ownership and typed results. Preserve context-token versus billing distinctions.
Done: child output cannot leak into parent state; partial snapshots cannot erase live work;
already-finished/not-found/cancelled outcomes are distinct; current and older extension fixtures
have honest capabilities and no broad process termination fallback.

## T05 — Local/Remote transport

Dependencies: T01-T04. Status: complete.
Writes: `src/contracts/`, `src/shared/ipc-channels.ts`, `src/main/ipc/`, `src/preload/`,
`src/hosts/server-core/`, `src/main/remote-host/`, relevant `src/clients/` and
`src/renderer/remote-host/` source contracts/tests; keep producer/consumer changes together.
Steps: wire typed native-work list/detail/stop operations and capability projection across both
hosts. Reuse existing event-read/session-write grants and checked session ownership. Project
private paths with existing Remote rules; no client-supplied provider path, PID or arbitrary RPC.
Synchronize method registry, parsers, preload facade, main registration and renderer callers.
Done: Local/Remote parity, parser bounds, authorization, cross-session rejection, stale attempts,
timeouts, reconnects, unsupported methods and subscription cleanup have contract coverage.

## T06 — Production interaction and remembered state

Dependencies: T05. Status: complete.
Writes: `src/renderer/components/SessionDetail/`, shared native-work components/hooks, relevant
activity-feed disclosure/context modules, scoped client preference helper and renderer tests.
Steps: port the approved 440-pixel strip/free-drag/popover prototype; retain conditional space,
chat palette, no outer controls/scrollbar, adaptive upward overlay and collapse-on-strip-scroll.
Wire real task source and stop outcomes; optimistic drag hiding restores on failure/timeout and
commits hidden state only after terminal confirmation. Keep separate Stop button behavior.
Remember per-client/host/session order, hidden attempts, task detail expansion and message/tool
disclosure using stable IDs. New attempts reappear. Default task output to existing MarkdownText.
Use an existing Tasks-tab section for retained native-work history, without conflating team tasks.
Done: prototype gesture cases plus async stop races, empty strip, narrow viewport, overlay height,
main content preservation, remembered state, safe Markdown and Local/Remote component parity pass.

## T07 — Answer recovery investigation and conditional repair

Dependencies: assembled-plan approval; independent of provider implementation. Status: complete.
Writes: narrowly scoped `src/main/ask-user/`, related IPC/MCP settlement, Core presentation, and
continuation recovery code/tests only when a reproduced application defect requires them.
Steps: test submission before/after abort, turn finish, session close and handoff; inspect the
resolve-before-best-effort-persist window; test saved answer materialization after interruption.
If an acknowledged answer can lose its durable record, fix settlement/recovery with a regression
that fails before the change. Preserve legitimate cancellation and stale-answer ownership checks.
Done: report reproduced defect and verified repair, or explicit evidence that no app defect was
reproduced. Do not describe the lead's late tool-result consumption as a proven app defect.

## T08 — Integration and final submission

Dependencies: T01-T07. Status: complete.
Writes: scoped integration fixes/tests, concise `README.md` feature/usage text, final `ref/` records
and indexes. Do not publish machine paths or copy generated provider schemas into tracked source.
Steps: run focused failures first, then required `pnpm typecheck`, `pnpm test`, `pnpm build` and
`git diff --check`; inspect files over 500 LOC, privacy and effective Git attribution. Verify the
production UI with the session Browser and controlled synthetic fixtures. Update review/plan/
changelog records with exact coverage and remaining live-runtime limits.
Done: approved behavior implemented for all supported owned-runtime paths, test/build evidence
recorded, README concise, source/history cleanly preserved, and the scoped validated changes
committed after identity/privacy checks. Preserve an ordinary Git branch for a detached worktree
commit before exiting; integrate only after checking the original worktree for newer changes.
Ask separately before an exact running-app restart or installation; do not push remotely.

## Acceptance log

T02: Claude retains explicitly owned child blocks, includes foreground local agents, buffers
bounded pre-registration frames, reads only provider-observed output references and scoped SDK
transcripts with matching owner markers. Exact stop returns accepted until native terminal
notification. Declares the SDK per-task stop affordance. Preserved translator/background/options
suites passed (29 tests); 2 new control/isolation tests passed after correcting a Vitest matcher.

T03: Codex session observer survives parent turn completion, discovers ownership from native
spawn/parent metadata, queries bounded child items and background-terminal pages, and fences
controls with process generation plus a fresh turn/process-item check. Three new fixture tests
passed. Static installed protocol regenerated into non-final scratch; local source revisions
remain Codex `4fd5745e8` and Grok `f049847c`. No provider inference or live cancellation occurred.

T04: native Grok lifecycle, bounded task snapshots/output, isolated child translation, current
runtime/owner/attempt checks and typed cancellation outcomes implemented. Truncated membership
does not erase active work. Eleven focused native-work/startup/recovery tests passed.

T05: Desktop IPC/preload, Core methods/grants/workspace checks, Remote service/input/result
validation and client facades wired. Task and detail pages are bounded; detached history is
read-only and unknown until reconciled. Eleven focused contract/service/Core/store tests passed.
Architecture and complete final checks passed; see validation.md.

T06: production strip/history/disclosure integration accepted. All 21 gesture tests and 8 new
production interaction tests passed, with Browser evidence for width, height, empty layout,
Markdown, stop retry, retained history and remembered expansion. No native pointer automation
or real provider control is claimed.

T07: two answer persistence defects reproduced before repair. Forty-one targeted tests passed
including durable continuation source retention; REVIEW_333 records findings and limits.

T08: `pnpm typecheck`, `pnpm test` (7,515 passed / 6 skipped), `pnpm build` and `git diff --check`
passed. Privacy, Git attribution, record buckets and source file sizes were inspected. README
remains concise. The final scoped local submission is on `feat/native-work-strip`; no push,
main-checkout cleanup, installation replacement or host restart was performed. See validation.md.
