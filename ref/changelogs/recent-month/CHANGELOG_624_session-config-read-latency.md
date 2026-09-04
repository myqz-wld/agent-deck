---
changelog_id: 624
changed_at: 2026-08-23
---

# CHANGELOG_624_session-config-read-latency: Keep adapter defaults inside the UI grace

## Summary

Local session-creation configuration now uses a bounded descriptor reader over the host
filesystem instead of a general-purpose Node read stream. Small Claude, Codex, and Grok config
files avoid the Electron stream lifecycle that was repeatedly reaching the 250 ms safety deadline,
and slow reads now identify their backend, stage, and end-to-end duration without recording paths
or content.

## Changes

### Bounded host-file reader

- Prefer Electron's `original-fs` for real host configuration paths, with ordinary
  `node:fs/promises` as the non-Electron fallback.
- Open one descriptor and read into one fixed `maxBytes + 1` buffer. The extra byte preserves exact
  oversize detection while preventing unbounded allocation or parsing.
- Retain the 250 ms outward settlement fence. A late open/read observes the abort boundary and
  closes its descriptor when the underlying operation returns.
- Remove the `ReadStream` data/end/error lifecycle from this latency-sensitive small-file path.

### Diagnostics

- Attach path-free backend, `opening` / `reading` / `closing` / `validating` stage, duration, and
  bounded byte count to config fallback diagnostics.
- Record successful config reads only when they cross the 150 ms presentation grace.
- Record adapter-level resolution latency when the complete IPC request crosses the same grace,
  without logging cwd or Gateway selection.

### Regression coverage

- Exercise the real descriptor reader against a small host file and a file larger than its
  configured limit.
- Prove timeout observations remain path/content-free and preserve custom-reader cancellation.
- Prove slow IPC diagnostics omit both working directory and Gateway values.

## Validation

- Focused Electron coverage: 6 files / 40 tests passed.
- Plain-Node fallback coverage: 2 files / 21 tests passed.
- Production-algorithm probe over the active config files completed in 0.11-2.73 ms.
- `pnpm typecheck`
- `pnpm build`
- `pnpm logger:check`
- Full suite excluding one pre-existing stale Browser README assertion: 1,000 files passed and 2
  skipped; 6,261 tests passed and 3 skipped.
- `git diff --check`

## Do Not Split Protection

No exception is required. The largest changed production file is
`src/main/adapters/session-creation-defaults-core.ts` at 413 lines; the optimized reader is 279
lines and the IPC boundary is 77 lines.

## Notes

- This is a performance/debug fix and does not change setup or user workflow, so README changes are
  not required.
- Main-process code changed. Installed-app acceptance requires a rebuilt package and restart; this
  session did not terminate its own host application.
- The repository baseline currently has one deterministic stale Browser README assertion outside
  this change. The unrelated Remote Issues timing failure from the first full run passed alone and
  in the exclusion run.

## Related review

- `ref/reviews/recent-3-days/REVIEW_261_session-config-read-latency.md`
