---
changelog_id: 428
changed_at: 2026-08-03
---

# CHANGELOG_428_provider-token-accounting-and-rate-repair: Repair provider token totals and tok/s

## Summary

Claude, Codex, and Grok token telemetry now respects each provider's actual usage semantics. Claude
no longer adds session-cumulative result snapshots once per turn, Codex rejects repeated cumulative
snapshots and context-only compaction totals, and Grok final tok/s uses provider API duration when
available. A narrow, idempotent startup repair corrects legacy rows that can be identified exactly.

## Claude

- Persist authoritative per-API-call assistant usage under provider message IDs, with progressive
  same-message frames max-merged instead of re-added.
- Keep a native-thread cumulative result watermark and emit only the positive final remainder that
  assistant rows did not already report. Native resumes baseline the first cumulative result rather
  than importing the preceding conversation again.
- Calibrate final tok/s with current-turn output instead of the session-cumulative result numerator.

## Codex

- Derive additive usage from `tokenUsage.total` growth and use `last` only for the first observation
  or servers without cumulative totals.
- Give cumulative snapshots stable thread-scoped message IDs, suppress unchanged replays, keep
  compaction-only snapshots in context occupancy only, and use the same delta for live tok/s.
- Preserve the cumulative watermark across turns and reset it when the native thread identity
  changes.

## Grok and historical data

- Prefer `apiDurationMs` over the shorter visible callback span for final tok/s, propagate that
  duration through ACP response and history-recovery paths, and exclude the first text chunk from
  an interval that starts only after its callback.
- On startup, convert only legacy Claude `result:*:model:*` / unattributed-reasoning rows whose IDs
  prove cumulative persistence into additive deltas. Delete only legacy Codex rows with no message
  ID, a positive provider total, and explicit zeroes in every actual usage dimension.
- Leave ambiguous historical Codex positive replays untouched; future cumulative fingerprints make
  those snapshots idempotent without guessing at old data.

## Validation

- Electron-ABI full suite: 449 files and 3,685 tests passed; one credentialed live smoke remained
  intentionally skipped.
- Focused Claude/Codex/Grok accounting, live-rate, and legacy-repair suites passed.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.
- Current-database read-only audit projected 17 identifiable Claude cumulative rows to additive
  deltas and identified 46 exact Codex context-only rows carrying 1,186,031 bogus provider-total
  tokens.

## Do Not Split Protection

- Claude assistant persistence, result watermarking, final remainder emission, and tok/s calibration
  are one accounting contract; landing only part reintroduces duplication or undercounting.
- Codex persistence and live-rate paths must consume the same cumulative observation, while stable
  IDs and startup cleanup provide the cross-restart boundary.
- Grok duration selection must remain paired with duration propagation through every completion
  path.

## Notes

- No credentialed live provider turn was run. Grok had no local database rows, so its no-duplication
  conclusion comes from 28 native completion records plus deterministic tests.
- Main-process changes and historical repair take effect on the next normal Agent Deck launch. The
  active collaboration host was not restarted because that would terminate this delivery session.
- Related audit: `REVIEW_211_provider-token-accounting-and-rate-repair.md`.
- All changes remain unstaged and uncommitted.
