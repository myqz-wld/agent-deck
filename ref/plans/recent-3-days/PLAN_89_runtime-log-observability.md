---
plan_id: 89
completed_at: 2026-10-14
---

# Runtime logging optimization

## Goal and authorization

Make Desktop, Worker/Core, and Relay logs useful, bounded, and private after the investigation in
REVIEW_323. The owner requested implementation, chose direct execution, and selected 10 MiB per
stdout/stderr channel with three backups, preserving existing history separately.

The source task is complete. No installed-runtime changes, service restarts, deployment, or
live-log deletion were authorized or performed. Concurrent permission/MCP work was preserved.

## Invariants and decisions

- Preserve provider permissions, request ordering, wire protocol, heartbeat thresholds, persistence,
  and Worker process identity. Diagnostics cannot own control flow. Add no LLM work.
- Keep raw messages, credentials, prompts, attachments, private paths, and forwarded bytes out of
  structured output; keep healthy heartbeat traffic quiet.
- Use fixed operational categories, allowlisted fields, anonymous run-scoped references, and
  bounded repeat aggregation. Desktop retains its existing logger pipeline and retention policy.
- Install managed Worker log handling before ESM import without a child supervisor; preserve
  launchd's open inode and archive history before truncation. Linux uses its journal lifecycle.
- Execute sequentially without delegated agents; keep a lightweight durable plan for the work.

## Completed tasks

1. Desktop summary severity/correlation and shutdown-only remote error suppression.
2. Headless structured default diagnostics and safe provider detail forwarding.
3. SSH failure-time heartbeat evidence and Relay attachment/expiry/forwarding observations.
4. Managed Worker bootstrap, bounded backups, legacy preservation, safe-path checks, retryable
   rotation, startup error aggregation, and non-fatal diagnostic failure handling.
5. Focused regressions, full typecheck/tests/builds, isolated built-bundle startup validation,
   packaging mapping, whitespace/privacy/file-size checks, documentation and final records.

## Validation and handoff

`pnpm typecheck`, full `pnpm test` (7,217 passed; 6 skipped), `pnpm build`, and
`pnpm build:linux-headless` passed. The two headless builds were reproducible; the 11 role outputs
and existing isolated Worker/Feishu bundle checks passed. The actual Worker bundle also loaded
through the new bootstrap outside the checkout before safely rejecting invalid synthetic config.
All scope files remain below 500 lines. No live instance was restarted or replaced.

The completed implementation and its limits are recorded in
`ref/changelogs/recent-3-days/CHANGELOG_678_runtime-log-observability.md` and
`ref/reviews/recent-3-days/REVIEW_324_runtime-log-observability.md`. The original investigation remains in
`ref/reviews/recent-3-days/REVIEW_323_claude-input-latency-and-runtime-logs.md`.

Next lifecycle step: load the new release on each affected component only after explicit exact
approval. Remaining diagnostic uncertainty is the reported other-machine latency and historical
heartbeat causes. Legacy log size, direct native output, and fallback behavior under file I/O
failure remain documented limits; no unresolved source implementation decision remains.
