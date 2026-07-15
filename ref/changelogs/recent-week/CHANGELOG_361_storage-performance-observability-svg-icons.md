---
changelog_id: 361
changed_at: 2026-07-11
---

# CHANGELOG_361_storage-performance-observability-svg-icons: Stage storage compaction and harden MCP readiness

## Summary

Agent Deck now stages its two largest local-storage maintenance jobs outside startup: event history
search moves from unbounded raw-JSON trigram indexing to a bounded, resumable projection, and file
snapshots move to compressed content-addressed blobs. Both paths retain compatibility reads, verify
across a restart, and retire legacy storage only after a clean drained shutdown. The same release
also makes the injected Agent Deck MCP server required for Codex threads, prevents repeated Codex
summary capability retries, applies provider-specific generator defaults, and replaces renderer
product-chrome glyphs with lightweight source-owned SVG components.

## Changes

### Staged event-search maintenance

- Added schema v41 with an update/delete-safe FTS5 contentless-delete index over a bounded generated
  search projection. Messages, thinking, tool names/input/status/error, file fields, and short final
  tool results remain fully indexed; final output longer than 4,096 characters keeps its first and
  last 2,048 characters. Start-event aggregate output is intentionally excluded.
- Dual-maintained the legacy and candidate indexes while the candidate is incomplete. History also
  continues to search session title, cwd, and summaries through their direct predicates.
- Added cursor-based candidate backfill, explicit durable phases, a 50-row cap, scheduler yields,
  disk-headroom gating, retry backoff, and content-safe progress/slow-path diagnostics. No full
  rebuild, optimize, integrity scan, or `VACUUM` runs during startup.
- Replaced count-only readiness with resumable `events -> candidate` and `candidate -> events`
  rowid verification plus deterministic MATCH samples. A missing row balanced by a phantom row can
  no longer authorize legacy-index retirement.
- Retire the legacy FTS only after adapter ingress, MCP, and lifecycle hooks have all drained. The
  worker transaction creates an empty compatibility table and marks completion; freed pages remain
  in SQLite's freelist for reuse instead of forcing a physical file rewrite.

### Content-addressed file snapshots

- Added SHA-256-addressed snapshot blobs using exact persisted UTF-8 bytes and raw DEFLATE level 1,
  with codec, raw-size, and compressed-size integrity metadata.
- New file-change writes insert verified blobs and hash references atomically, keep legacy blob
  fields unchanged, and avoid storing new inline snapshot text. Hash collisions or malformed blob
  metadata fail safely instead of returning incorrect content.
- Reads join and decode hash-backed snapshots with a per-read cache while retaining legacy inline
  fallback during migration. Legacy values already carrying the truncation marker are encoded as
  persisted values and are not truncated a second time.
- Added byte-aware resumable backfill and two-pass verification, a required restart verification,
  bounded legacy clearing, and deferred orphan cleanup. The partial hash indexes are deliberately
  created by the shutdown worker only after a clean post-clear drain; GC stays parked until those
  indexes are durable.
- Added slow file-change persistence metadata without logging file paths or snapshot content.

### Isolated shutdown storage worker

- Corrected the warm-cache shutdown assumption with fresh cold-copy measurements: legacy FTS
  retirement takes 5.81-5.99 seconds, and snapshot hash-index preparation takes 843.94 ms. Neither
  synchronous operation is releasable on Electron main even after ingress has drained.
- Added a bundled Node worker entry that opens its own better-sqlite3 connection only after the main
  lifecycle proves adapters, MCP, and hooks drained. The main connection remains open but idle and
  is closed unconditionally after worker completion or failure.
- Kept the two durable tasks independently retryable. One task failure is returned as a bounded
  structured outcome and cannot prevent the other task from progressing; durable phase advancement
  stays inside each task's SQLite transaction.
- Added a cheap phase check so ordinary shutdown does not spawn a worker, a typed worker protocol,
  fatal/error/early-exit handling that never terminates an in-flight SQLite transaction, and an
  explicit worker-data marker that prevents test worker pools from executing the entry accidentally.

### Codex MCP readiness and delivery recovery

- Marked the automatically injected `agent-deck` MCP server as required. Codex thread start/resume
  now fails visibly when the collaboration surface is unavailable instead of silently returning a
  session whose only `send_message` is the unrelated native collaboration tool.
- Added a bounded/redacted Agent Deck-only MCP startup observer for `starting`, `ready`, `failed`,
  and `cancelled`, plus wall-time diagnostics around Codex thread boundaries.
- Made app-server initialize and thread readiness retryable after rejection, kept stderr and exit
  ownership per child process, and ignored stale exit events from replaced children.
- Made universal-message recovery retries idempotent for the same stable wire event, preventing
  duplicate user messages, recovery placeholders, and error bubbles while preserving delivery
  retry semantics.
- Made adapter registry shutdown return per-adapter outcomes. Destructive storage retirement runs
  only when every ingress owner and lifecycle hook stopped successfully; database close remains
  mandatory even when optional maintenance is skipped or fails.

### Summary capability circuit and provider defaults

- Added a typed permanent summary-provider capability error and an app-lifetime provider circuit.
  The unprovable Codex summarizer tool registry now produces one actionable warning, records local
  fallback diagnostics per affected session, and is not retried on every scan until restart.
  Ordinary transient provider failures continue to retry.
- Continuation Context now defaults to `high` thinking; an empty Claude model resolves to Opus and
  an empty Codex model remains unset so Codex uses its configured model.
- Periodic summaries now default to `medium` thinking; an empty Claude model resolves to Haiku and
  an empty Codex model remains unset so Codex uses its configured model.
- Added a one-time uplift for the prior summary/continuation default values, then preserve every
  later explicit user choice. Settings defaults are cloned before passing them to electron-store so
  one user's persisted values cannot mutate the process-wide fallback object.

### Lightweight renderer SVG chrome

- Added a source-owned `components/icons` layer with one accessible SVG primitive, domain-split
  path definitions, `currentColor`, consistent 24x24 geometry, and an imperative DOM counterpart
  for the one non-React close control. No icon package or runtime asset dependency was added.
- Replaced small interactive product glyphs across the header, session cards/detail, settings,
  dialogs, history, permissions, issues, assets, diff, team panels, activity rows, and composer.
  User/provider content and semantic prose emoji remain unchanged.
- Pinned and unpinned states now use the same pushpin silhouette: emphasized/filled when pinned and
  muted outline when unpinned. The map-location pin is no longer used for session/window pinning.
- Extracted `AppHeader`, permissions panels, issue controls, and message-status chrome so the broad
  icon pass remains within the repository's production-file size policy.
- Preserved and strengthened semantics while replacing glyphs: icon-only close/back controls have
  explicit names, selectable question options expose `aria-pressed`, sender/from/to and pending
  counters include screen-reader text, decorative semantic emoji are hidden from accessibility,
  and the imperative fatal-banner close button now has button type, label, and title.

### Documentation

- Documented the bounded long-output History search boundary, staged storage lifecycle, absence of
  automatic `VACUUM`, reusable freelist behavior, and the forward-only downgrade boundary after
  compatibility retirement.
- Documented provider-specific empty-model and default-thinking behavior for Continuation Context
  and periodic summaries.

## Validation

- A consistent SQLite online backup of the v40 production-size database was created and verified:
  1,897,799,680 bytes, 181,308 events, 10,524 file changes, `quick_check=ok`. The live running
  database was never opened for benchmark writes.
- Product-binding copy benchmarks rejected the invalid `contentless_delete=1,columnsize=0`
  combination and validated the supported default-columnsize contentless-delete design. The
  candidate is about 372.9 MiB versus the legacy 1,031.5 MiB FTS allocation; its full build takes
  about 31 seconds and is therefore staged rather than placed in startup.
- Snapshot copy benchmarks measured 289.4 MiB of legacy `file_changes` allocation versus 108.7 MiB
  after verified hash/compression cutover, a 180.7 MiB logical saving. Point join+inflate reads were
  0.042/0.161 ms p50/p95. Removing startup hash indexes reduced v41 migration time from a cold
  715-747 ms scan to 2.406 ms.
- The selected snapshot slice policy (backfill max 8, verification max 12, soft 512 KiB raw budget)
  measured backfill p95/p99 18.27/24.00 ms and restart-verification max 21.65 ms on a fresh copy.
  Later shared-connection runs exposed rare 97-185 ms WAL auto-checkpoint tails; this is recorded as
  a follow-up rather than hidden by disabling checkpointing and allowing roughly 496 MiB WAL growth.
- The revised full-copy gate passed row-set equivalence, injected equal-count missing/orphan
  rejection, restart verification, deterministic MATCH samples, compatibility writes, and
  quick/FK checks. Cold old-FTS retirement took 5.81-5.99 seconds; an isolated Electron worker
  proof completed it in 7.44 seconds while a 5 ms main-thread heartbeat stayed responsive with
  at most 1.36 ms drift.
- Cold snapshot index preparation took 843.94 ms; the worker proof completed it in 878.9 ms while
  heartbeat drift stayed at 1.30 ms. These cold results replace the earlier cache-warm 33.021 ms
  observation as the release decision.
- The actual built worker passed under product Electron Node with the main connection open and idle:
  FTS retirement reported 6,405.29 ms task / 6,446.82 ms total and only 1.70 ms heartbeat drift;
  snapshot indexes reported 29.49 ms task / 73.67 ms total and 1.50 ms drift. A forced count failure
  returned a bounded independent result, left the phase retryable, then succeeded after repair;
  close/reopen rowset, compatibility, quick-check, and foreign-key gates passed.
- Final post-record repository gate passed: 263 files / 2,502 tests, `pnpm typecheck`,
  `pnpm build`, `pnpm logger:check`, and `git diff --check`. The review-expiry check passed, and
  every changed production file remains at or below 500 lines.
- The final commit is included in this delivery.

## Do Not Split Protection

- No production-file exception is planned. Storage maintenance, icon definitions, permissions,
  issue controls, header chrome, recovery delivery, and MCP observation are split into focused
  modules. Final confirmation remains part of the repository validation gate above.

## Notes

- No migration, rebuild, drop, optimize, `VACUUM`, or snapshot rewrite was performed against the
  live running database. All destructive experiments used independent APFS clones of one
  consistent online backup.
- Released FTS/snapshot pages become reusable inside SQLite, but the physical database file does
  not shrink automatically. This is expected behavior, not a failed migration.
- Once v41 has retired compatibility storage, older Agent Deck builds cannot read every hash-only
  snapshot or candidate-only search entry. Downgrade recovery requires restoring a verified
  pre-upgrade database backup while Agent Deck is stopped.
- Main-process, schema, settings, and renderer changes become active after a safe application
  restart. The app was not restarted or overwritten while it owned active work.
- Follow-up issue `ed009981-889f-4de8-9ba0-1c25e0f67e09` tracks moving the remaining staged
  backfill/verification slices off Electron main. Disabling WAL auto-checkpoint was rejected because
  it removed latency tails by allowing roughly 496 MiB of WAL growth.

## Related Records

- [REVIEW_152](../../reviews/recent-3-days/REVIEW_152_storage-performance-observability-svg-icons.md)
- [PLAN_6](../../plans/recent-3-days/PLAN_6_storage-performance-observability-svg-icons.md)
