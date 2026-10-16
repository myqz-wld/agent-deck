# T01 — Native work model, history and parent isolation

Owner: lead implementation session. Status: complete; final-plan approval reused.
Classification: complex. Delegation: none. Acceptance owner: lead.

## Goal and inputs

Implement the shared identity/lifecycle/history foundation for the approved native-work strip.
Read `../../PLAN_97_native-work-strip.md`, `../evidence.md`, the approved prototype and REVIEW_331 first. D01-D12 are
already resolved; do not repeat their questions. Verify that the pre-existing Claude isolation
repair was carried into the isolated workspace before changing its integration.

First source reads: `src/shared/background-task.ts`, `src/contracts/session-events.ts`,
`src/main/store/event-repo.ts`, `src/main/store/event-revision-read.ts`,
`src/main/session/manager-ingest-pipeline.ts`, `src/main/session/manager.ts`,
`src/main/session/continuation-context/event-normalizer.ts`.

## Allowed writes

- Shared native-work types/reducers under `src/shared/` and typed contracts under `src/contracts/`.
- Native-work repository/query modules and narrowly required integration in `src/main/store/`.
- Parent/child event routing in `src/main/session/` and corresponding Core ingestion composition.
- Focused tests beside changed modules and this task's execution/result sections.

Do not change the database schema/version, installed runtimes, prompt assets, unrelated stores,
or production strip UI. Provider implementations and public transport registration follow in
T02-T05; define their typed ports here without performing runtime actions.

## Implementation steps

1. Define task kind, owner, native entity, attempt/run, state, summary, detail ownership and exact
   control reference. Keep existing background-task snapshot parsing backward compatible.
   Only Claude specifies lexical ordering for its run IDs; use provider-specific turn/attempt
   and runtime-generation evidence for other providers rather than sorting arbitrary IDs.
2. Define bounded child-activity envelopes distinct from parent tool/message identity. Validate
   malformed data, stable provider IDs and nesting/size limits before storage or rendering.
3. Add a repository over the existing events table for current task states and cursor-based child
   detail/output reads. Preserve revision semantics, deduplicate replay and chunk large UTF-8 text
   below current payload limits. Retain history under the parent's deletion cascade.
4. Keep task discovery independent of the main feed's recent-event limit. Filter owned detail
   before parent pagination and before parent continuation/summarization/context/lifecycle logic.
5. Define the provider observation/control port and shared stop outcomes needed by T02-T05.
6. Record implementation paths, tests, constraints and next task in this file and the plan.

## Required behavior and validation

- A child with the same tool ID as a parent/other child does not overwrite their tool records.
- More than 200 ordinary events do not evict a running task from the task list.
- Duplicate replay does not duplicate activity or add billed usage; late old-run events cannot
  revive/replace the current attempt. Parent finish does not complete live tasks.
- Long multilingual output survives bounded chunks/pages without invalid UTF-8 or silent claims
  of completeness for upstream-truncated data.
- Child output is durable and separately readable, and parent deletion cleans it up.
- Parent activity, model context, pending ownership, live rate and billing remain correct.
- Existing schema version/fingerprint remains unchanged and architecture boundaries pass.

Run focused repository tests through the approved runner and relevant contract tests. Record
results; the final full typecheck/test/build is owned by T08.

## Stop/report conditions

If correctness requires a schema compatibility change, live inference, arbitrary filesystem reads,
or a different user-owned retention policy, report the concrete evidence before proceeding.
Do not replace missing provider identity with a guessed task/thread/path or generic parent stop.

## Execution and acceptance

Implementation result: shared `contracts/native-work.ts` / `shared/native-work.ts` define
owner, attempt and exact runtime references, strict flat detail records and UTF-8-safe chunks.
`main/store/native-work-repo.ts` adds independent current-state reads and bounded detail pages
over existing events. Snapshot/detail replay is idempotent, old attempts cannot replace newer
ones, and shorter detail replacements remove obsolete tails. Parent event pagination and
revision/continuation reads exclude child detail. Desktop and Core ingestion bypass parent
lifecycle/context/billing for detail events. Schema version and SQL are unchanged.

Validation result: Electron harness passed 4 real-store tests plus 19 preserved Claude
translation tests (23 total). Tests cover >200 parent events, replay revision stability,
opaque run ordering, terminal revival rejection, Unicode pages, tool-ID isolation, malformed
ownership, replacement tails and parent deletion cascade. The named normalizer-test path did
not exist and contributed no test coverage; continuation integration remains in T08 checks.

Lead acceptance: accepted. The final T08 run also passed parent-consumer/ingestion coverage,
contract checks, full typecheck, full tests and build; see ../validation.md.
