---
review_id: 187
reviewed_at: 2026-07-29
baseline_commit: a63033bdeeecdf3aba0d6d31a5818e5dc41c679a
reviewed_head: 0428a65aff91e811f770815b2a17f93952434e5d
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final record creation and bucket rebucketing are mechanical archive work."
---

# REVIEW_187_whole-project-quality-refresh: Final integration and performance audit

## Scope and method

This record consolidates the source-traced audits, failure-first fixes, SQLite benchmarks,
interruption tests, adapter contract matrices, and final integration validation from
`a63033bd..0428a65a`. The branch changes 481 paths; the exact file-level scopes remain in their
own batch tests and commit history. The `review-scope` below covers the final B23 packaging and
dependency integration only and is not intended to exempt the earlier 481-path branch from future
file-level expiry rules.

The final pass remained Codex-only because the active runtime constraint prohibited invoking
Claude Code or Grok Build. It therefore does not claim the plan's optional heterogeneous final
review. B21 did receive a separate Codex adversarial review and its output-contract findings were
fixed before integration.

```review-scope
README.md
package.json
pnpm-lock.yaml
scripts/verify-bundled-grok.mjs
src/main/adapters/grok-build/__tests__/packaging-preflight.test.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Existing V42 databases could execute the explicitly offline V43 FTS rebuild during ordinary startup, and a crash between replacement renames lacked durable recovery. | Startup now plans only the startup-safe prefix, refuses before RW/WAL mutation, and directs the user to a journaled copy-first CLI with resume, rollback, validation, and idempotent finalize. |
| HIGH | Spawn could create a provider target and then fail team/anchor setup or MCP output validation, leaving a live target behind an error result. | Add preflight, strict post-create rollback reporting, a shared success schema, structured content, and a real 257-character Agent-name call test through the production server. |
| HIGH | Terminating a worker thread blocked inside native `better-sqlite3` can abort the whole Electron process. | Reject `Worker.terminate()` for the current controller. Keep cooperative shutdown and document the remaining terminal-policy decision below. |
| HIGH | Raw errors, identifiers, paths, payloads, and repeated success/failure noise crossed many persisted logging boundaries. | Introduce safe diagnostics plus bounded transition/summary/recovery coordinators and remove duplicate adapter-local sources. |
| MEDIUM | File changes, permission files, Issue membership, team lifecycle, token retention, and several renderer payloads could scan or decode an unbounded set synchronously. | Add bounded SQL/paging/byte/depth/count contracts, targeted reads, catch-up timers, stale-generation fences, and explicit retry states. |
| MEDIUM | Production daily token aggregation took about 2.1 seconds at 1 million rows and 14.1 seconds at 5 million rows. | V55 persists revisioned dirty-day rollups; projected reads are about 3.8 ms and unchanged-revision reads about 0.04–0.11 ms on the measured fixture. |
| MEDIUM | The pending-message query used a temp sort and a full production tick reached about 443–451 ms at 1 million rows. | Offline V56 adds a partial `(status, sent_at)` pending index; the unchanged production tick fell to about 8 ms with byte-identical result/FIFO fingerprints. |
| MEDIUM | Team lifecycle scanned every active team in one synchronous tick; a 10,000-team fixture exceeded 300 ms when archiving. | Limit each batch to 1,000 teams, retain 200-row paging, and schedule bounded catch-up without skip or starvation. |
| LOW | Target-specific dist commands could verify the host Grok payload and then ask electron-builder for a foreign OS artifact. | Pin each dist command to an explicit target and fail when OS or architecture differs from the host. |

## Evidence

- Token rollup evidence used exact production SQL and Electron 33.4.11 / SQLite 3.49.2. At one
  million rows, raw median/p95 was 2,125.55/2,214.34 ms; projected fresh was 3.846/3.925 ms and
  revision-cache warm was 0.041/0.079 ms.
- Message dispatch evidence used exact production eligible/exclusion/count queries. At one million
  mixed rows, V55 tick fresh median/p95 was 442.85/450.79 ms; V56 was 7.99/8.22 ms.
- The task-edge gate remained closed: current JSON cleanup p95 was 75.07 ms at 100,000 tasks and
  crossed 250 ms only between 250,000 and 500,000 retained explicit MCP-created tasks.
- The maintenance native spike reproduced a fatal `v8::ToLocalChecked Empty MaybeLocal` abort when
  terminating a worker blocked in a native SQLite call. Disposable crash databases recovered
  correctly, but process safety did not.
- The dependency registry check on 2026-07-29 found Claude Agent SDK `0.3.220`, Anthropic SDK
  `0.115.0`, MCP SDK `1.29.0`, and ACP SDK `1.3.0` current; Codex CLI and Grok Build advanced to
  `0.146.0` and `0.2.114`.
- Final typecheck, logger check, build, native package preflight, macOS distribution, and the full
  466-file / 3,996-test suite passed.

## Fixes landed

- Runtime/collaboration: `dc7400a1..c7972ec8`, `105d9d43`, and `be789ccb`.
- Renderer/security/storage: `0725b21d..f0559b73`.
- Copy and state-transition logging: `fe4aceda..35cfe9f5`.
- MCP prompt/output contract: `490dc6c2`.
- Benchmark-gated persistence/index/query/lifecycle changes: `4a49b7a5..c79ca785`.
- Native packaging and dependency refresh: `ca143072` and `0428a65a`.

## Residual risk

- Maintenance terminal policy remains an architecture decision. Safe near-term option A disables
  maintenance after the first timeout until restart and never terminates the worker. Same-run
  forced recovery requires option B: a dedicated child process with kill/recovery semantics and a
  per-phase crash matrix. The current implementation was intentionally not changed without that
  choice.
- The Codex watchdog/recycle helper and several owner-scoped legacy log sites still contain
  privacy/noise debt outside B20's approved scope. B20 is complete as a scoped batch, not a claim of
  repository-wide zero raw diagnostics.
- The first V55 full token projection rebuild is synchronous on first unbounded daily read; the
  5-million-row synthetic fixture took about 14.1 seconds. Migration startup itself remains
  schema-only.
- No live app restart, installed-app overwrite, or three-runtime interactive smoke was performed,
  because the running Agent Deck instance owned active shared sessions. Native packaging and
  in-memory/Electron integration tests passed without replacing that app.
- No checked-in CI workflow exists. The supported artifact contract is native-host packaging;
  every release runner must use the matching OS and architecture.

## Follow-ups

1. Choose maintenance option A or B before changing worker terminal behavior.
2. After active sessions are safely closed, install the newly built native app and run one
   interactive smoke per adapter.
3. Re-run the task-edge benchmark only after retained task count approaches 250,000 or cleanup p95
   reaches 250 ms.
