---
changelog_id: 592
changed_at: 2026-08-12
---

# CHANGELOG_592_remote-full-ui-parity: Complete source-authoritative Remote UI parity

## Summary

Remote now uses the same capability-backed workspace structure as Local across navigation,
session lists and details, Pending, Teams, Issues, Data, Settings, Assets, session creation,
and handoff. The implementation preserves strict source authority: unsupported or unavailable
Remote surfaces fail closed, never read Local state as a fallback, and never dispatch a stale
mutation to a replacement Core generation.

## Changes

### Transport, protocol, and lifecycle

- Add bounded protocol 2.4 presentation, Pending, permissions, asset, Hook, runtime, and session
  creation surfaces while retaining the supported 2.2/2.3 compatibility path.
- Reserve both frame slots and bytes for heartbeat control traffic, validate minimum queue
  capacity on client and daemon admission, and preserve strict duplicate/unknown response rules.
- Advance Active, Dormant, and Closed lifecycle state in Worker authority and publish truthful
  global totals. Legacy pagination keeps the server total while deriving visible section counts
  from all loaded rows instead of treating one page as an aggregate.

### Desktop source authority and refresh

- Model source authority explicitly as unknown, Local, or Remote. Initial/snapshot-error unknown
  states mount neither Local nor Remote business readers; Local focus and store bridges run only
  under confirmed Local authority.
- Carry resource-specific invalidations from Core events through Main to independent renderer
  refresh lanes for lists, detail, Pending, Teams, Issues, usage, assets, and Hook state.
- Fence refreshes, pagination, detail loads, confirmations, and mutation results by profile,
  authoritative Core, Worker generation, revision, cursor, and query as applicable.
- Bind every Renderer-exposed Remote mutation to the captured Core id and Worker generation;
  Main rejects missing or mismatched authority before selecting a client or dispatching to Core.

### Renderer parity and interaction

- Align Live, History, Pending, detail tabs, Teams, Issues, Data, Settings, Assets, new-session,
  connection, and handoff layouts while preserving explicit read-only or unsupported boundaries.
- Share session presentation and lifecycle grouping, preserve pinned state as a read-only Remote
  indicator, and provide a usable stacked Issues master/detail flow at the supported 380 px width.
- Add modal semantics, focus trapping/restoration, nested-select Escape priority, and truthful
  field summaries. A Core-disabled Provider/model field is summarized as unavailable; the
  disclosure itself remains enabled and expandable.
- Serialize runtime edits, recheck identity and eligibility at execution time, retry a same-session
  model edit after a busy interval, flush on blur, and keep StrictMode mount rehearsal safe.

### Security and deployment boundaries

- Exclude sensitive paths and values before projection, bind asset and image reads to one
  same-handle canonical identity, and reject symlink/intermediate-directory swaps before bytes.
- Bind file-change authority and snapshot bytes at ingestion, require every Remote final-diff
  history row to match that authority, and revalidate deleted paths through the current nearest
  canonical parent. Reserved authority metadata never leaves Local or Remote public DTOs.
- Serve Remote Hook status from runtime-owned state without reading provider configuration;
  failed adapters are not advertised as ready for creation or Hook mutation.
- Ship a bounded non-secret Remote session catalog example and wire it through the supported
  Relay/Full Worker configuration path with fail-closed empty defaults.

## Validation

- The full Electron-as-Node suite passed 943 files and 6,043 tests; three explicitly conditional
  live/environment tests remained skipped.
- Both heterogeneous I1 reviewers independently converged after targeted correction review:
  reviewer-codex ran 22 files / 117 tests and reviewer-claude ran 26 files / 154 tests.
- Direct Node and Web TypeScript checks, architecture and Core/Node boundaries, the production
  Electron build, Linux headless build/check, deployment automation, Relay static check, Full
  static check, diff hygiene, touched-file size checks, and file-level review expiry passed.
- Earlier package-boundary validation also passed macOS Worker sandbox and bundled-runtime checks.
  No live desktop, Worker, credential, provider-private, or deployment state was mutated.
- Full review details are recorded in `REVIEW_233_remote-full-ui-parity.md`.
- The grouped audit and paired-review manifest are archived under `ref/evidence/` and indexed in
  `ref/evidence/INDEX.md`.

## Do Not Split Protection

No exception is required. All changed production TypeScript files are at or below 500 lines; the
largest touched service test boundary is exactly 500 lines and production logic is split into
focused authority, validation, refresh-lane, and presentation modules.

## Notes

- “Disabled-field summary” means the collapsed summary text for a Core-disabled option says
  “unavailable”; it does not disable the summary/disclosure control.
- The complete corrected line is delivered on `main` at `dc4943bb`; the exact macOS package was
  built and passed its packaged Worker boundary check. Installed acceptance still waits for that
  exact package to replace the older installed build.
