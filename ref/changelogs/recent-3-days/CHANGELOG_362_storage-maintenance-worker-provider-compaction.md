---
changelog_id: 362
changed_at: 2026-07-12
---

# CHANGELOG_362_storage-maintenance-worker-provider-compaction: Isolate staged storage and restore Codex compact generation

## Summary

Agent Deck now runs all bounded v41 event-search and snapshot maintenance slices, compression,
writes, and live PASSIVE WAL checkpoints through a persistent dedicated SQLite worker connection.
Electron main retains only scheduling and a safely restored checkpoint lease, so rare maintenance
commit checkpoints no longer stall renderer/main responsiveness.

The same delivery restores real Codex periodic summaries and Continuation Context checkpoint
generation inside an explicitly accepted hardened-but-unattested boundary, removes `minimal` from
new Codex thinking inputs, migrates legacy generator settings to `low`, improves summary diagnostics,
and updates the Codex and Claude SDK dependencies.

## Storage maintenance

- Added a bundled persistent maintenance worker and versioned request/result protocol. The worker
  owns event/snapshot slices, hashing/DEFLATE, writes, and periodic PASSIVE checkpoints.
- Acquires the main connection's WAL autocheckpoint lease only after worker readiness, restores the
  original threshold on every stop/fatal/error/exit path, and never force-terminates a synchronous
  SQLite operation.
- Freezes restart eligibility once per app run and preserves it across worker replacements.
- Correlates one in-flight request per generation, ignores stale replies, uses watchdog retirement,
  and queues a separately correlated close so a lost slice reply cannot hang shutdown.
- Revalidates event projections and snapshot legacy values inside short write transactions, keeps
  ingress atomic across connections, and protects snapshot GC's reference probe/delete with an
  immediate transaction.
- Keeps destructive FTS retirement and snapshot-index creation in the existing shutdown-only worker
  after all ingress owners drain. Live commands expose no DROP, index-build, optimize, VACUUM, or
  non-PASSIVE checkpoint operation.

## Codex summary and Continuation Context

- Allows Codex periodic summaries and Continuation Context checkpoints to run in an empty temporary
  cwd with read-only sandboxing, `approvalPolicy=never`, no network/base config/MCP/dynamic tools,
  no extra/runtime roots, and executable features disabled.
- Keeps the documented residual limitation that Codex 0.144.1 cannot attest its final model-visible
  built-in tool registry. Checkpoint output is accepted only after structured-schema canonicalization,
  exact evidence allowlisting, active/blocked fact carry-forward, revision coverage, and transactional
  CAS persistence validation.
- Fixed the live Codex structured-output schema by requiring every declared fact property, including
  `rationale` and `validation`; older persisted checkpoints remain compatible with optional fields.
- Propagates non-retry app-server terminal errors instead of misreporting invalid schemas as empty
  successful output.
- Expected provider capability fallback now opens one provider-lifetime circuit and logs once at
  info without polluting per-session recent-summary errors. Real transient provider failures remain
  diagnostic and are cleared after a successful retry.

## Thinking levels and dependencies

- New Codex inputs now accept `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; `minimal` is
  rejected by settings, UI, config/custom-agent parsing, adapter options, and MCP schemas.
- Persisted summary/Continuation generator `minimal` settings migrate to `low`. Historical session
  display and token-bucket recognition remain readable without rewriting history.
- Claude/Deepseek effort remains `low` through `max`. Claude `ultracode` is an orchestration mode,
  not a new `ultra` effort value.
- Updated `@openai/codex` to 0.144.1, `@anthropic-ai/claude-agent-sdk` to 0.3.207, and
  `@anthropic-ai/sdk` to 0.111.0.

## Validation

- Full repository gate: 268 test files and 2,531 tests passed; one opt-in live test was skipped in
  the ordinary suite. Typecheck, build, logger check, and `git diff --check` passed.
- The opt-in real Codex 0.144.1 checkpoint smoke passed separately and returned canonical schema-valid
  output. The independent reviewer additionally ran a non-empty evidence smoke that produced three
  validated facts and entered the persistence chain.
- Built Electron worker verification passed with `quick_check=ok`, zero foreign-key violations, and
  0.677 ms maximum 5 ms-heartbeat drift.
- Continuous-ingress worker validation measured main writes at 1.631 ms p95, 4.216 ms p99/max,
  heartbeat drift at 2.818 ms max, WAL high-water at 7,992,832 bytes, and clean quick/FK checks.
- Independent `gpt-5.6-sol` / `xhigh` review passed with no CRITICAL/HIGH/MEDIUM findings. Its sole
  LOW comment-drift finding was fixed.

## Known evidence limitation

- The current synthetic and file-backed gates prove packaging, WAL ownership, concurrency,
  responsiveness, and integrity. A fresh disposable 1.9 GiB production-shape copy tail rerun was not
  available in this session and remains release evidence rather than a correctness blocker.

## Related records

- [REVIEW_153](../../reviews/recent-3-days/REVIEW_153_storage-maintenance-worker-provider-compaction.md)
- [PLAN_7](../../plans/recent-3-days/PLAN_7_storage-maintenance-worker-provider-compaction.md)
