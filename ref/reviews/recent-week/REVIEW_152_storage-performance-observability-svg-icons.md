---
review_id: 152
reviewed_at: 2026-07-11
baseline_commit: 2042b3c659726bf0365c3f812e80b23418981d37
expired: false
skipped_expired: []
---

# REVIEW_152_storage-performance-observability-svg-icons: Storage maintenance and Codex MCP readiness

## Scope and Method

This standalone lead audit continued REVIEW_151's measured storage and observability follow-ups. It
inspected the post-restart application logs, reconstructed the affected Codex SDK session timeline,
traced Codex app-server/MCP startup and universal-message recovery, reviewed the complete working
tree, and exercised schema v41 only against consistent production-size database copies. Per the
user's explicit instruction, it did not invoke `simple-review` or `deep-review` and did not treat a
formal reviewer workflow as evidence.

Writable storage experiments used APFS clones of one SQLite online backup. The live running
database was never migrated, rebuilt, dropped, optimized, vacuumed, or opened for benchmark writes.
The benchmark harness used Agent Deck's product Electron/better-sqlite3 runtime for product gates.

```review-scope
README.md
src/main/adapters/__tests__/registry.test.ts
src/main/adapters/codex-cli/__tests__/codex-model-passthrough.test.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/codex-cli/app-server/client.test.ts
src/main/adapters/codex-cli/app-server/client.ts
src/main/adapters/codex-cli/app-server/mcp-startup-observer.test.ts
src/main/adapters/codex-cli/app-server/mcp-startup-observer.ts
src/main/adapters/codex-cli/app-server/thread.ts
src/main/adapters/codex-cli/sdk-bridge/client-registry.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/_deps.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer/universal-delivery.ts
src/main/adapters/codex-cli/summarizer-runner.ts
src/main/adapters/registry.ts
src/main/codex-config/__tests__/agent-deck-mcp-injector.test.ts
src/main/codex-config/agent-deck-mcp-injector.ts
src/main/index/__tests__/_deps.test.ts
src/main/index/_deps.ts
src/main/index/bootstrap-infra.ts
src/main/index/lifecycle-hooks.ts
src/main/session/__tests__/summarizer-revision-cursor.test.ts
src/main/session/__tests__/summarizer-runner.test.ts
src/main/session/continuation-context/__tests__/resolver.test.ts
src/main/session/continuation-context/resolver.ts
src/main/session/summarizer/index.ts
src/main/session/summarizer/llm-runners.ts
src/main/session/summarizer/provider-capability-error.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/__tests__/file-change-repo.test.ts
src/main/store/__tests__/file-snapshot-codec.test.ts
src/main/store/__tests__/settings-store-continuation.test.ts
src/main/store/__tests__/v041-migration.test.ts
src/main/store/event-repo.ts
src/main/store/file-change-repo.ts
src/main/store/file-snapshot-codec.ts
src/main/store/file-snapshot-reader.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v041_storage_maintenance_staging.sql
src/main/store/search-predicate.test.ts
src/main/store/search-predicate.ts
src/main/store/session-repo/__tests__/_setup.ts
src/main/store/session-repo/core-crud.ts
src/main/store/settings-store.ts
src/main/store/storage-maintenance/event-search.ts
src/main/store/storage-maintenance/file-snapshots.ts
src/main/store/storage-maintenance/index.ts
src/main/store/storage-maintenance/scheduler.ts
src/main/store/storage-maintenance/shutdown-contract.ts
src/main/store/storage-maintenance/shutdown-runner-protocol.test.ts
src/main/store/storage-maintenance/shutdown-runner-protocol.ts
src/main/store/storage-maintenance/shutdown-runner.ts
src/main/store/storage-maintenance/shutdown-tasks.test.ts
src/main/store/storage-maintenance/shutdown-tasks.ts
src/main/store/storage-maintenance/shutdown-worker.ts
src/main/store/storage-maintenance/state.ts
src/main/store/storage-maintenance/storage-maintenance.test.ts
src/renderer/App.tsx
src/renderer/components/AppHeader.tsx
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/DataPanel.tsx
src/renderer/components/DeckSelect.tsx
src/renderer/components/HandOffPreviewDialog.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/ImageLightbox.tsx
src/renderer/components/IssueDetail.tsx
src/renderer/components/MessageStatusBadge.tsx
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/PendingTab.tsx
src/renderer/components/PermissionsView.tsx
src/renderer/components/ResolveInNewSessionDialog.tsx
src/renderer/components/SessionCard.tsx
src/renderer/components/SessionDetail/ComposerSdk.tsx
src/renderer/components/SessionDetail/DiffTab.tsx
src/renderer/components/SessionDetail/MessagesPanel.tsx
src/renderer/components/SessionDetail/composer-sdk/ErrorBanner.tsx
src/renderer/components/SessionDetail/composer-sdk/ImageIcon.tsx
src/renderer/components/SessionDetail/index.tsx
src/renderer/components/SessionPinButton.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/SummaryView.tsx
src/renderer/components/TeamDetail/Header.tsx
src/renderer/components/TeamDetail/MembersSection.tsx
src/renderer/components/TeamDetail/MessagesSection.tsx
src/renderer/components/TeamDetail/PendingSection.tsx
src/renderer/components/TeamDetail/TasksSection.tsx
src/renderer/components/TeamDetail/helpers.ts
src/renderer/components/TeamDetail/index.tsx
src/renderer/components/activity-feed/format.ts
src/renderer/components/activity-feed/rows/message-row.tsx
src/renderer/components/activity-feed/rows/thinking-row.tsx
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/components/assets/AssetCard.tsx
src/renderer/components/assets/AssetEditor.tsx
src/renderer/components/assets/ContentViewerModal.tsx
src/renderer/components/diff/renderers/ImageDiffRenderer.tsx
src/renderer/components/diff/renderers/TextDiffRenderer.tsx
src/renderer/components/icons/SvgIcon.tsx
src/renderer/components/icons/actions.tsx
src/renderer/components/icons/chrome.tsx
src/renderer/components/icons/content.tsx
src/renderer/components/icons/dom.ts
src/renderer/components/icons/icons.test.tsx
src/renderer/components/icons/index.ts
src/renderer/components/icons/people.tsx
src/renderer/components/issue-detail-controls.tsx
src/renderer/components/pending-rows/AskRow.tsx
src/renderer/components/pending-rows/ExitPlanRow.tsx
src/renderer/components/pending-rows/diff-review-presentation.tsx
src/renderer/components/permissions/ClaudePermissionsPanels.tsx
src/renderer/components/permissions/CodexPermissionsPanel.tsx
src/renderer/components/permissions/permission-chrome.tsx
src/renderer/components/settings/ClaudeMdEditor.tsx
src/renderer/components/settings/CodexAgentsMdEditor.tsx
src/renderer/components/settings/controls.tsx
src/renderer/components/settings/sections/AgentDeckMcpSection.tsx
src/renderer/components/settings/sections/ContinuationContextSection.tsx
src/renderer/components/settings/sections/KeyboardShortcutsSection.tsx
src/renderer/components/settings/sections/LogViewerModal.tsx
src/renderer/components/settings/sections/LogsSection.tsx
src/renderer/components/settings/sections/SummarySection.tsx
src/renderer/components/settings/sections/WindowSection.tsx
src/renderer/components/settings/sections/__tests__/ContinuationContextSection.test.tsx
src/renderer/components/settings/sections/__tests__/SummarySection.test.tsx
src/renderer/hooks/useLastSessionDefaults.ts
src/renderer/main.tsx
src/shared/types/settings.ts
src/shared/types/settings/app-settings.ts
src/shared/types/settings/defaults.ts
```

## Gate Status

**PASS.** The revised full-copy correctness gate, actual built-worker release gate, final full
repository gate, durable-record checks, review-expiry check, and changed-production LOC guard all
passed. Cold-copy evidence invalidated the earlier warm-cache shutdown assumption, and the bundled
worker closes that release blocker.

Final finding distribution after implementation and validation:

- CRITICAL: 0 identified
- HIGH: 5 fixed in the working tree
- MEDIUM: 6 fixed in the working tree
- LOW: 2 dispositioned as measured residual risks
- Remaining known CRITICAL/HIGH: 0

## Post-Restart Evidence and MCP Root-Cause Boundary

The installed app restarted at 2026-07-11 18:52:03 PDT with the REVIEW_151 instrumentation. No
post-restart `main event loop delay` or `slow event persistence` warning was observed. One
`hand_off_session` request took about 7.7 seconds, but its checkpoint-preparation interval accounts
for that wall time and neither synchronous signal fired; this sample is asynchronous hand-off work,
not evidence of a SQLite/main-loop stall.

A bounded live no-write MCP probe completed `initialize` in 25 ms and a valid `get_session` request
for a nonexistent UUID in 4 ms. The Agent Deck HTTP route, current port, token, authentication, and
config syntax were therefore healthy at the time of diagnosis.

The affected Codex SDK session crossed an application stop/restart boundary and later exposed no
Agent Deck MCP tools. Its native Codex `send_message` rejected an Agent Deck session UUID as
`agent not found`, which confirms the call was misrouted through Codex's unrelated native
collaboration surface. Historical logs did not persist the app-server MCP startup-status event, so
the exact old subfailure—transient connection, auth, cancellation, or timing—cannot be recovered.

Isolated Codex 0.144 reproduction establishes the actionable cause boundary:

- with Agent Deck MCP optional, `thread/resume` could return in about 149 ms while healthy Agent
  Deck tools became ready only around 5.3 seconds later;
- an invalid optional server could return thread success in about 33 ms and report failure roughly
  2.8 seconds later;
- marking the server required made start/resume wait roughly 4.4-5 seconds or fail with
  `required MCP servers failed to initialize`.

Therefore the product bug was optional, fail-open MCP initialization: a thread could become usable
without the collaboration tools its bundled protocol requires. The working-tree fix injects
`required: true`, observes only Agent Deck's redacted startup lifecycle, resets rejected initialize
and readiness promises, and prevents a stale child exit from clearing a replacement process.

The remaining 4-5 second cold readiness interval comes from Codex app-server handshake pacing, not
Agent Deck's millisecond HTTP handler. Perceived `send_message` response latency can additionally
include cold session recovery and the receiver model turn; the server-side enqueue itself still
returns immediately after durable queueing.

## Findings and Resolutions

### HIGH fixed: optional MCP startup silently created tool-less Codex sessions

The injected Agent Deck MCP server was optional. Codex could complete a thread boundary before
tools were ready or after an eventual MCP failure, leaving the model without `mcp__agent-deck__*`
and encouraging accidental use of native collaboration routing.

Resolution: make the injected server required, log bounded/redacted startup state and thread wall
time, retry rejected initialize/readiness attempts, and isolate child-process exit/stderr state.

### HIGH fixed: equal-count FTS verification could retire a good rollback index after corruption

The first exact v41 copy gate deleted one candidate row and added one phantom row. Candidate and
event counts stayed equal, so count-only restart and shutdown gates advanced to retirement despite
explicit `missing=1` and `orphan=1`. FTS5 integrity checks also passed and took about 2.9 seconds;
they test internal index structure, not equivalence with `events`.

Resolution: durable two-direction rowid verification in bounded cursor slices, followed by
deterministic MATCH samples. Measured 1,000-row proof slices were about 0.93 ms p50 for
events-to-candidate and 4.39/7.69 ms p50/p95 for candidate-to-events, and both injected bad rowids
were detected. The revised full-copy gate then passed both row-set directions, injected equal-count
missing/orphan refusal, restart verification, deterministic MATCH samples, and compatibility DML.

### HIGH fixed: startup hash-index DDL scanned the 289 MiB legacy snapshot table

Although every legacy hash was NULL, SQLite still scanned `file_changes` while creating the two
partial indexes. Fresh-copy runs measured 714.885 and 747.476 ms; one first-index statement was
733.513 ms. This violated the O(1) startup-migration requirement.

Resolution: omit those indexes from startup, finish hash backfill/verification/legacy clear, then
create both transactionally only after an already drained shutdown. The same copy measured v41
migration at 2.406 ms without the indexes. A later cold gate measured post-clear index creation at
843.94 ms rather than the earlier cache-warm 33.021 ms; it therefore runs in the isolated shutdown
worker. GC remains parked until the indexes exist and state reaches complete.

### HIGH fixed: destructive maintenance was not tied to complete ingress drain evidence

Legacy FTS DROP is destructive and intentionally runs only at shutdown. Running it after a partial
adapter/MCP/hook stop could overlap a late write and eliminate the rollback path.

Resolution: adapter shutdown now reports every adapter outcome, and lifecycle code runs storage
retirement/index work only when adapters, MCP, and lifecycle hooks all stopped successfully. Each
optional task fails independently; the mandatory database close still runs.

### HIGH fixed: cold shutdown storage transactions blocked Electron main for seconds

The earlier 339 ms FTS retirement and 33 ms index measurements were cache-warm and understated the
release path. Fresh cold copies measured old-FTS retirement at 5.81-5.99 seconds and snapshot index
preparation at 843.94 ms. Complete ingress drain makes these transactions logically safe but does
not make synchronous better-sqlite3 work responsive.

Resolution: a bundled Node worker opens an isolated better-sqlite3 connection only after the main
lifecycle proves full ingress drain. Separate proofs completed the FTS transaction in 7.44 seconds
with at most 1.36 ms drift on a 5 ms main-thread heartbeat and snapshot indexes in 878.9 ms with
1.30 ms drift. The implementation performs a cheap phase check before spawning, returns independent
bounded results for both retryable tasks, does not terminate an in-flight worker transaction, keeps
the main connection open but idle, and closes it unconditionally afterward. Protocol tests cover
success, fatal message, worker error, and early exit; task tests cover phase selection and one-task
failure isolation.

The actual built artifact then passed its release gate under the product Electron runtime with the
real main connection open and idle. FTS retirement reported 6,405.29 ms task time / 6,446.82 ms
worker wall with 1.70 ms maximum heartbeat drift. Snapshot preparation reported 29.49 ms task time /
73.67 ms worker wall with 1.50 ms drift. A forced count mismatch returned one structured task
failure, kept state retryable, preserved the independent task outcome, and succeeded after repair;
close/reopen rowset, compatibility, quick-check, and foreign-key checks passed.

### MEDIUM fixed: permanent Codex summary capability failure retried and amplified logs per scan

After restart, `__codex_summarizer_tools_unproven__` appeared eight times across six sessions,
often twice in one scan. This is a build/provider capability result, not a transient session error.

Resolution: raise a typed capability error and open one provider-level circuit for the process
lifetime. Emit one actionable warning, preserve per-session local-fallback diagnostics, and skip
later provider attempts until restart. Transient provider failures retain normal retries.

### MEDIUM fixed: universal-delivery retries could duplicate recovery UI events

The same queued wire message can legitimately retry after provider recovery failure. The recovery
path emitted the user bubble, placeholder, and final error again even though the durable message
identity had not changed.

Resolution: detect the stable universal wire event already persisted for the session and suppress
only duplicate UI emissions on retry. Queue state and provider delivery retry remain unchanged.

### MEDIUM fixed: row-count-only maintenance budgets hid large snapshot work

Earlier exact-copy runs reached 140.85 ms snapshot backfill and 60.44 ms verification slices.
Snapshot byte size, not row count, dominates compression and SQLite work.

Resolution: use max 8 backfill rows, max 12 verification rows, and a soft 512 KiB combined raw
budget while always allowing one oversized row to make cursor progress. Fresh-copy policy runs
measured backfill p95/p99 18.27/24.00 ms and verification max 21.65 ms. A rare single-row/WAL tail
remains documented below.

### MEDIUM fixed: persisted legacy snapshots could be truncated twice

Legacy rows may already contain the storage truncation marker. Passing them through the new-write
encoder as fresh input could truncate the persisted representation again and make byte-for-byte
verification or fallback semantics incorrect.

Resolution: separate fresh snapshot encoding from persisted-legacy encoding, hash the exact stored
legacy string, and cover the existing-marker case with a regression fixture.

### MEDIUM fixed: provider defaults and shared settings fallbacks could drift

Continuation and summary generators did not match the requested provider-specific blank-model and
thinking defaults. In addition, electron-store could retain and mutate the exported defaults object.

Resolution: continuation defaults to high with blank Claude -> Opus and blank Codex -> configured;
summary defaults to medium with blank Claude -> Haiku and blank Codex -> configured. One-time
legacy uplift preserves later explicit choices, and electron-store receives a structured clone.

### MEDIUM fixed: glyph replacement exposed inherited accessibility gaps

Several icon-only close/back controls relied on visual shape or `title`, selected question options
had only color state, and compact message/pending counters exposed symbols without complete spoken
context. Replacing glyphs without fixing those semantics would preserve appearance but degrade
keyboard/screen-reader clarity.

Resolution: add explicit accessible names to icon-only close/back controls, `aria-pressed` to
selectable question options, screen-reader from/to and pending-count labels, and `aria-hidden` to
retained decorative semantic emoji. The imperative fatal-banner close is now an explicit button
with label/title. Shared SVGs default to `aria-hidden`, `focusable=false`, and `currentColor`, with a
tested opt-in label when an icon is meaningful on its own.

### LOW tracked: staged maintenance retains rare shared-connection checkpoint tails

Fresh-copy runs observed rare 97-185 ms WAL auto-checkpoint tails while bounded backfill and
verification slices still use Electron main's shared connection. Disabling auto-checkpoint removed
the tail only by allowing roughly 496 MiB of WAL growth, so that tradeoff was rejected. Follow-up
issue `ed009981-889f-4de8-9ba0-1c25e0f67e09` tracks moving the remaining staged slices off main.

### LOW dispositioned: screenshot QA was unavailable without an attached browser window

No in-app browser window was attached for screenshot comparison of the renderer icon pass.
Source-level icon inventory, focused renderer/accessibility tests, full typecheck, and the built
renderer passed; screenshot inspection remains a next-safe-restart observation rather than a
release blocker.

## Storage Copy Evidence

### Baseline and safety

The online backup at the copy boundary was 1,897,799,680 bytes, schema v40, with 181,308 events,
10,524 file changes, and `quick_check=ok`. Every writable experiment started from an independent
clone. No benchmark ran `VACUUM`.

### Event search

- Legacy FTS allocation: 1,031.5 MiB over unbounded `payload_json` trigrams.
- Product SQLite 3.49.2 rejects `contentless_delete=1` with `columnsize=0`; that invalid combination
  is not shipped or retried.
- The supported contentless-delete/default-columnsize bounded candidate is about 372.9 MiB and
  passed insert/update/delete, crash-resume, MATCH, and copy integrity fixtures.
- Full candidate construction takes about 31 seconds, so v41 creates only empty schema/state at
  startup and backfills later in resumable slices. Event backfill is capped at 50 rows.
- Message/thinking and file-path fixtures retain 100% coverage. Output-only fixture coverage is
  93.37% because only the first/last 2,048 characters of outputs longer than 4,096 remain indexed.
  README makes this intentional lossy boundary explicit.
- The revised copy gate passed row-set equivalence, corruption refusal, restart/MATCH checks,
  compatibility writes, and quick/FK checks. Cold legacy retirement took 5.81-5.99 seconds and
  moved about 1,031.5 MiB to the freelist; the physical file did not shrink, as expected.
- A separate worker proof completed retirement in 7.44 seconds while 5 ms main-thread heartbeat
  drift remained at or below 1.36 ms.
- The actual built worker passed with 6,405.29 ms task time / 6,446.82 ms total wall and only
  1.70 ms maximum positive heartbeat drift. Reopen preserved 181,308/181,308 rowset equality,
  empty compatibility FTS, `quick_check=ok`, and zero foreign-key violations.

### File snapshots

- 19,959 references contain 259.6 MiB raw snapshot text; 10,681 unique values contain 144.1 MiB.
- SHA-256 content addressing plus raw DEFLATE level 1 reduces measured `file_changes` + blob-table
  allocation from 289.4 MiB to 108.7 MiB after verified legacy clearing, a 180.7 MiB saving.
- Level 1 compressed all unique values in 1.169 seconds in the standalone codec benchmark; level 6
  saved only another 6.7 MiB while using 2.44x the CPU time.
- Hash join + inflate point reads measured 0.042/0.161 ms p50/p95.
- Backfill, two verification passes, restart gate, clear, index creation, and indexed queued GC are
  explicit phases. New writes use hash-only snapshots atomically while legacy reads remain valid
  during staging.
- Cold post-clear index creation took 843.94 ms, replacing the earlier warm-cache 33.021 ms
  assumption. A worker proof took 878.9 ms with 1.30 ms maximum heartbeat drift.
- The actual built worker reported 29.49 ms task time / 73.67 ms total wall with 1.50 ms drift in
  its cache-warm run; both indexes, 19,959 references, 10,681 blobs, zero legacy rows, and zero
  unresolved hashes passed close/reopen integrity.

### Shutdown worker architecture

- A cheap read on the main connection recognizes only `retire-on-shutdown` and
  `indexes-on-shutdown`, so ordinary shutdowns do not spawn a worker.
- The bundled `?nodeWorker` entry validates a versioned worker-data marker, opens its own file-backed
  better-sqlite3 connection with busy timeout/foreign keys/trusted schema, runs both task helpers,
  posts one structured result, and always closes its connection.
- Each task advances only its own durable phase inside its transaction. One bounded failure cannot
  block the other; a future app restart can retry the unchanged phase.
- Main awaits result/error/exit without force-terminating synchronous SQLite work, logs each outcome
  without content, then unconditionally closes the primary connection for its checkpoint.
- The built-artifact failure gate removed one candidate row, returned a bounded per-task count
  mismatch with exit code 0, left `retire-on-shutdown` durable, preserved the independent snapshot
  result, and succeeded after repair. Message order was `task-start -> result -> exit(0)`.

## Renderer and Defaults Inspection

The renderer no longer relies on Unicode/emoji for product chrome. One source-owned SVG primitive
and domain-split icon modules cover add/close, pushpin, collapse/expand, settings, library,
copy/open, attachment, chevrons, permission/team/status, and other interactive affordances. The
pinned and unpinned controls share the same pushpin path, using fill/emphasis versus muted outline;
the map pin is gone. SVGs are decorative (`aria-hidden`, non-focusable), while existing button
labels, tooltips, pressed state, and hit targets remain the accessible contract. Semantic prose and
provider/user content emoji were intentionally left alone.

The pass also adds explicit names to inherited icon-only close/back buttons, pressed semantics to
question choices, spoken direction/count context, and hides retained decorative semantic emoji.
The non-React fatal close control now carries button type, label, and title.

The broad icon pass also extracted the header, message-status badge, permissions panels, and issue
controls. Every changed production file remains at or below 500 lines.

## Validation and Evidence Status

- Focused summary/MCP/recovery/storage suites previously reached 8 files / 94 tests after the main
  remediations. Renderer typecheck/build and 34 renderer files / 255 tests also passed before the
  final storage-policy adjustments. These are supporting evidence, not substitutes for the final
  gates.
- Snapshot policy comparison on fresh copies selected max-8/max-12/512-KiB based on measured tail
  latency and progress; all compared completed runs produced 10,681 blobs, 19,959 references, and
  zero unresolved values.
- Revised exact-current-code v41 copy gate passed equivalence, injected missing/orphan refusal,
  restart verification, deterministic MATCH samples, compatibility DML, and quick/FK checks. Its
  cold shutdown measurements triggered the worker remediation described above.
- The actual built shutdown worker passed success, heartbeat responsiveness, independent failure,
  durable retry, state transition, compatibility DML, rowset, close/reopen, quick-check, and
  foreign-key gates using the built `shutdown-worker-*.js` artifact under product Electron Node.
- Final post-record repository gate passed: 263 files / 2,502 tests, `pnpm typecheck`,
  `pnpm build`, `pnpm logger:check`, and `git diff --check`. The review-expiry check passed, and
  every changed production file remains at or below 500 lines.
- The final commit is included in this delivery.

## Residual Risk

The two LOW findings above remain the tracked checkpoint tail and the dispositioned screenshot-QA
gap. The remaining bullets below are measured operational constraints or explicit product tradeoffs,
not additional severity-counted findings.

- The historical tool-less Codex process did not persist its MCP startup error, so the precise old
  transient subcause remains unknowable. Required startup and the new observer convert any future
  recurrence into a visible, bounded failure with evidence.
- Cold Codex thread start/resume can now take roughly 4-5 seconds because required MCP readiness
  waits for app-server handshake pacing. This is intentional fail-closed behavior; Agent Deck's
  measured HTTP initialize/tool calls remain millisecond-scale.
- Cold FTS retirement still lengthens total app shutdown by about 6.4 seconds. The worker keeps the
  event loop responsive and is deliberately not force-terminated mid-transaction.
- `retire-on-shutdown` is trusted state produced by two-direction verification and distributed MATCH
  samples. The worker rechecks counts, not the full rowid set; an artificial equal-count corruption
  injected after the trusted gate could evade that last check, while normal drained flow has no
  remaining writer capable of creating it.
- Bounded staged backfill/verification slices still use the shared main connection. Fresh-copy runs
  saw rare 97-185 ms WAL auto-checkpoint tails. Disabling auto-checkpoint removed the tail but grew
  WAL by roughly 496 MiB, so that unsafe tradeoff was rejected. Follow-up issue
  `ed009981-889f-4de8-9ba0-1c25e0f67e09` tracks moving all staged work off main; this release limits
  worker isolation to the two much larger shutdown-only transactions.
- Search no longer finds text appearing solely in the middle of tool output longer than 4,096
  characters. This tradeoff is tested and user-visible in README.
- DROP and snapshot clearing free reusable SQLite pages but do not shrink the physical file. No
  automatic `VACUUM` is justified.
- After compatibility retirement, v41 is forward-only. An older build requires a verified
  pre-upgrade database restored with Agent Deck stopped.
- Screenshot QA for the icon pass was unavailable because no in-app browser window was attached;
  structural renderer tests and build coverage remain the automated gate.

## Follow-up / Handoff

1. Commit and push the validated records and implementation. Do not restart or overwrite the
   running application while it owns active work.
2. At the next safe restart, monitor MCP startup state, main-loop/event-persistence warnings,
   summary capability aggregation, and storage-maintenance phase progress. Resolve the two tracked
   storage issues only after the landed commit and restart behavior justify closure.
