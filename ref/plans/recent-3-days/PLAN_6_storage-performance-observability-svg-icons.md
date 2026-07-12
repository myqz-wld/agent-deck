---
plan_id: PLAN_6
title: Storage performance, MCP readiness, and SVG icon unification
status: completed
created_at: 2026-07-11
updated_at: 2026-07-11
completed_at: 2026-07-11
owner_task_id: b9787042-0e76-4a2f-9751-541c065ca482
base_branch: main
base_commit: 2042b3c659726bf0365c3f812e80b23418981d37
related_changelog: CHANGELOG_361
related_review: REVIEW_152
---

# PLAN_6_storage-performance-observability-svg-icons: Storage performance, MCP readiness, and SVG icons

## Goal

Safely address REVIEW_151's production-size event-search and file-snapshot storage risks, validate
post-restart slow-path evidence, fix repeated summary and MCP initialization failures, unify all
small renderer product-chrome icons as lightweight source-owned SVGs, and apply the requested
provider-specific generator defaults without mutating the live running database or creating a new
startup/main-thread cliff.

## Context and Constraints

- Work started from clean `main` / `origin/main` at
  `2042b3c659726bf0365c3f812e80b23418981d37`.
- The user explicitly requested autonomous handling and prohibited `simple-review` and
  `deep-review`; evidence comes from standalone lead inspection, logs, product-binding tests, and
  controlled production-copy benchmarks.
- The live database stayed untouched. A consistent SQLite online backup was the sole source for
  writable experiments, and every experiment used a fresh independent clone.
- No full FTS rebuild, snapshot backfill, integrity scan, DROP, optimize, or `VACUUM` may occur in
  the synchronous startup migration. Destructive retirement requires complete ingress drain.
- Existing event and snapshot data must remain readable throughout staging. Search narrowing must
  be explicit, tested, and documented rather than silently losing useful user intent.
- Product chrome may use source-owned SVG components only; no heavyweight icon dependency. The
  same pushpin silhouette represents both states: emphasized/filled pinned, muted outline unpinned.
  User/provider content and semantic prose emoji are outside the icon migration.
- All production source remains subject to the 500-line split guardrail.

## Confirmed Decisions

### Event history search

- Keep source events intact and replace only the search projection.
- Use product-supported FTS5 `contentless_delete=1` with default column-size metadata. Product
  SQLite 3.49.2 rejects the tempting `columnsize=0` combination, so it is explicitly excluded.
- Index complete messages/thinking and typed tool/file fields. Keep final tool output through 4,096
  characters; for longer output index the first and last 2,048 characters. Do not index start-event
  aggregate output. Search session cwd/title and summaries through their direct predicates.
- Backfill in resumable slices with dual-read compatibility. Verify both rowid directions across a
  restart and run deterministic MATCH samples before authorizing retirement.
- Drop the legacy index only after every ingress owner has drained. Keep an empty compatibility FTS
  table, move freed pages to SQLite's freelist, and never auto-VACUUM. Run the cold retirement
  transaction on a dedicated worker connection while the main connection remains open but idle.

### File snapshots

- Store exact persisted snapshot UTF-8 bytes under SHA-256 in a `WITHOUT ROWID` blob table, using
  raw DEFLATE level 1 and explicit codec/size integrity metadata.
- New writes are hash-only and atomic; reads use hash joins with legacy inline fallback during
  migration. Persisted legacy truncation markers are not truncated again.
- Backfill, verify, restart-verify, clear, index creation, and GC are explicit durable phases.
  Snapshot work is row- and byte-bounded; the two partial indexes are built on the shutdown worker
  only after clearing and complete ingress drain, and GC remains parked until they are durable.

### MCP and summary reliability

- The bundled Agent Deck protocol requires its MCP surface, so injected Codex configuration must
  set `required: true`. A thread that cannot initialize those tools must fail visibly rather than
  continue with unrelated native collaboration tools.
- Observe only Agent Deck MCP lifecycle status and sanitize/bound every error. Rejected initialize
  and thread attempts must be retryable, and stale child exits must not clobber replacement state.
- Universal delivery retries are idempotent at the stable wire-message boundary.
- `__codex_summarizer_tools_unproven__` is a permanent provider/build capability failure. Open one
  process-lifetime circuit, warn once, retain per-session fallback diagnostics, and continue retrying
  only genuinely transient errors.

### Generator defaults

- Continuation Context: blank Claude -> Opus, blank Codex -> Codex configured model, default
  thinking `high`.
- Periodic summaries: blank Claude -> Haiku, blank Codex -> Codex configured model, default
  thinking `medium`.
- Uplift only the exact prior default values once, then preserve explicit user selections.

### SVG product chrome

- Use one shared accessible SVG primitive with `currentColor`, consistent 24x24 geometry, rounded
  stroke semantics, and domain-split source definitions.
- Replace every inventoried small interactive glyph: header/session pins, add/close,
  collapse/expand, settings, library, copy/open/external-link, attachment, chevrons, permission,
  issue, team, status, asset, diff, pending, and composer controls.
- Preserve accessible labels, tooltips, pressed state, and hit targets. SVGs are decorative and
  non-focusable.

## Completed Work

### 1. Post-restart diagnosis and log amplification

- Verified the installed slow-path markers and inspected logs after the 18:52:03 restart.
- Found no post-restart main-loop or event-persistence warning. Attributed one 7.7-second handoff to
  asynchronous checkpoint preparation rather than synchronous SQLite work.
- Measured live read-only MCP `initialize` at 25 ms and `get_session` at 4 ms.
- Reconstructed the tool-less Codex SDK session boundary, reproduced optional app-server MCP
  fail-open behavior, and implemented required startup plus bounded lifecycle diagnostics.
- Replaced repeated per-scan summary capability attempts with a typed provider circuit.

### 2. Production-copy storage evidence

- Created and verified a 1,897,799,680-byte v40 online backup containing 181,308 events and 10,524
  file changes; `quick_check=ok`.
- Benchmarked full/core/bounded FTS candidates, source coverage, query latency, incremental writes,
  update/delete support, cursor backfill, crash/restart behavior, DROP, corruption, and row-set
  verification using independent copies.
- Benchmarked raw deduplication, DEFLATE levels, blob allocation, insert/read latency, deletion/GC,
  startup DDL, deferred indexes, and multiple row/byte slice policies.
- Recorded that bounded contentless FTS is about 372.9 MiB versus 1,031.5 MiB legacy allocation and
  that verified snapshot cutover reduces combined allocation from 289.4 MiB to 108.7 MiB.

### 3. Schema v41 and maintenance runtime

- Added the v41 empty schema/state migration, bounded generated search source, dual-maintenance
  triggers, contentless candidate FTS, snapshot blob table, nullable hash references, and GC queue.
- Added storage-maintenance state/repository modules and one scheduler with delayed startup, yields,
  per-task retry/backoff, disk checks, and deduplicated logs.
- Added resumable FTS backfill, two-direction restart verification, deterministic MATCH samples,
  candidate-only cutover, and drained-shutdown retirement with compatibility table recreation.
- Added exact snapshot codec/collision checks, hash-only atomic new writes, cached dual-join reads,
  persisted-legacy encoding, byte-aware backfill/verify/clear, shutdown index creation, and indexed
  queued orphan cleanup.
- Gated destructive shutdown work on successful adapter, MCP, and lifecycle-hook drain, while
  keeping database close mandatory.

### 4. Isolated shutdown maintenance worker

- Re-ran shutdown operations on cold copies and corrected the earlier warm-cache decision: old-FTS
  retirement takes 5.81-5.99 seconds and snapshot index preparation takes 843.94 ms.
- Proved worker feasibility at 7.44 seconds / 1.36 ms heartbeat drift for FTS and 878.9 ms /
  1.30 ms drift for snapshot indexes, then implemented the bundled `?nodeWorker` architecture.
- Added a cheap pending-phase gate, versioned worker-data/message contract, isolated file-backed
  better-sqlite3 connection, independent bounded task outcomes, fatal/error/early-exit handling,
  and no force termination of in-flight synchronous SQLite work.
- Kept the main connection open but idle while awaiting the worker, then close it unconditionally.
  A task failure leaves its durable phase retryable and does not discard the other task's result.
- The actual built artifact passed under product Electron Node: FTS task 6,405.29 ms / worker
  6,446.82 ms / heartbeat drift 1.70 ms; snapshot task 29.49 ms / worker 73.67 ms / drift 1.50 ms.
  Structured count failure, durable retry, independent result, compatibility DML, rowsets, and
  close/reopen quick/FK checks passed.

### 5. Codex app-server and universal delivery hardening

- Marked the injected Agent Deck MCP server required and added isolated lifecycle observation.
- Added retry-safe initialize/readiness state, redacted thread-boundary timing, per-child stderr,
  and stale-exit ownership checks.
- Suppressed duplicate recovery user/placeholder/error bubbles only when retrying the same stable
  universal wire event.

### 6. Provider defaults and summary behavior

- Added provider-aware blank-model resolution and the requested high/medium thinking defaults.
- Added one-time legacy uplift and tests that preserve later explicit choices/provider switches.
- Cloned exported defaults before electron-store initialization to prevent mutation aliasing.

### 7. SVG icon unification and component splits

- Added the source-owned domain-split icon layer and replaced all inventoried small interactive
  renderer glyphs without adding a dependency.
- Used one shared pushpin path for filled pinned and outline unpinned states; removed the map pin.
- Kept semantic content emoji and provider/user text intact.
- Extracted header, message-status, permissions, and issue-control modules to keep responsibilities
  and file sizes bounded.
- Added explicit names to icon-only close/back controls, `aria-pressed` to question options,
  screen-reader direction/count labels, `aria-hidden` on decorative semantic emoji, and full button
  semantics to the imperative fatal close control.

### 8. Documentation and tests

- Documented bounded long-output search, staged storage maintenance, reusable freelist behavior,
  no automatic VACUUM, forward-only v41 retirement, and provider-specific generator defaults.
- Added migration, storage-maintenance, corruption, snapshot codec/read/write, settings, summary,
  MCP observer/client/recovery, registry/lifecycle, renderer icon, and accessibility coverage.

## Validation Evidence

- Product-copy benchmark evidence already completed:
  - baseline backup `quick_check=ok`;
  - invalid `contentless_delete=1,columnsize=0` rejected by the actual product binding;
  - supported contentless-delete DML/MATCH/crash-resume fixtures passed;
  - pre-fix missing+phantom corruption reproduced and sliced two-direction detection proved;
  - no-startup-index v41 migration measured 2.406 ms; a later cold gate corrected post-clear index
    creation from the earlier warm 33.021 ms to 843.94 ms;
  - selected snapshot policy measured backfill p95/p99 18.27/24.00 ms and restart verification max
    21.65 ms; later runs retained rare 97-185 ms shared-connection WAL checkpoint tails as a
    tracked residual rather than disabling checkpointing and growing WAL by roughly 496 MiB.
- Supporting focused gates reached 8 files / 94 tests for the main summary/MCP/storage changes and
  34 renderer files / 255 tests before the final storage-policy adjustment. They do not replace the
  final gates below.
- Revised exact-current-code copy gate passed equivalence, injected missing/orphan refusal, restart
  verification, deterministic MATCH, compatibility DML, and quick/FK checks. Cold FTS retirement
  measured 5.81-5.99 seconds; cold snapshot indexes measured 843.94 ms.
- The built shutdown worker passed product-artifact success/heartbeat, independent failure/retry,
  state, compatibility, rowset, and reopen integrity gates. FTS was 6,405.29 ms task / 6,446.82 ms
  total / 1.70 ms drift; snapshots were 29.49 ms / 73.67 ms / 1.50 ms drift.
- Final post-record repository gate passed: 263 files / 2,502 tests, `pnpm typecheck`,
  `pnpm build`, `pnpm logger:check`, and `git diff --check`. The review-expiry check passed, and
  every changed production file remains at or below 500 lines.
- The final commit is included in this delivery.

## Completion

The implementation, production-copy gates, built-worker release gate, durable records, full
repository validation, review-expiry check, and changed-production LOC guard are complete. The
validated change set is ready for commit and push to `main` / `origin/main`. The running app remains
untouched; a later safe restart should monitor MCP readiness, summary aggregation, slow-path
warnings, and maintenance phases.

## Known Risks and Handoff

- The precise historical MCP initialization subfailure was not persisted. The fail-open boundary
  is reproduced and fixed; the new observer provides actionable evidence for any recurrence.
- Required MCP readiness intentionally exposes Codex app-server's roughly 4-5 second cold handshake
  instead of returning a tool-less session early.
- Tool output found only in the middle of more than 4,096 characters is no longer searchable.
- Staged backfill/verification still shares Electron main's connection and has rare 97-185 ms WAL
  checkpoint tails. Disabling checkpoints was rejected because WAL grew by roughly 496 MiB. Issue
  `ed009981-889f-4de8-9ba0-1c25e0f67e09` tracks moving all staged work off main.
- Cold FTS maintenance still adds about 6.4 seconds to total shutdown, but the worker keeps the main
  loop responsive and is intentionally not force-terminated mid-transaction.
- Freed storage becomes SQLite freelist capacity and does not shrink the main file automatically.
- After compatibility retirement, downgrade requires restoring a verified pre-upgrade backup while
  Agent Deck is stopped.
- Visual screenshot QA remains unavailable without an attached in-app browser window; automated
  renderer structure/accessibility/build gates cover the current handoff.

First action after this record: commit and push the validated change set. Keep the live v40 database
untouched until the commit is pushed and the user can restart safely.
