---
changelog_id: 355
changed_at: 2026-07-10
---

# CHANGELOG_355_filter-desktop-ephemeral-codex-hooks: Hide Desktop ambient Codex hooks

## Summary

ChatGPT / Codex Desktop transcript-less ephemeral background generations no longer appear as Agent Deck external terminal sessions. Persistent Desktop sessions, ordinary terminal Codex sessions, and user-launched terminal ephemeral sessions remain visible.

## Root Cause

The user-level `~/.codex/hooks.json` is also loaded by ChatGPT Desktop's bundled long-lived Codex app-server. Its `ambient_suggestions` generation and `ambient_suggestion_safety` check emitted normal Codex hooks without `AGENT_DECK_ORIGIN=sdk`, so the hook route classified them as external CLI sessions even though both were ephemeral and had no rollout transcript.

## Changes

- Added a Codex-specific ingress filter before hook translation, session creation, and event persistence.
- Required all of these signals before ignoring a hook session:
  - hook origin is external CLI;
  - raw hook payload explicitly contains `transcript_path: null`;
  - the reported parent PID belongs to a Codex app-server hosted by the same ChatGPT / Codex Desktop application.
- Kept classification fail-open: missing fields, unsupported platforms, process lookup failures, or unrecognized packaging preserve the hook.
- Cached the first decision for each session so mixed or older hook payloads cannot cause partial ingestion.
- Cached PID classification for five minutes and capped both caches to avoid repeated `ps` / PowerShell calls and unbounded growth.
- Added macOS and Windows host recognition. Other platforms currently preserve events until a stable Desktop host contract exists.
- Added one safe diagnostic log for an ignored `SessionStart`; tool-heavy turns do not log once per event.

## Compatibility Boundary

Filtering on a missing transcript alone was rejected because Codex supports user-requested ephemeral threads whose path is also null. Terminal-owned ephemeral app-servers remain visible because their parent process is a shell rather than ChatGPT / Codex Desktop.

## Validation

- Focused Codex hook / ingest suite: 5 files and 51 tests passed.
- `pnpm typecheck`
- `pnpm test` — 205 files and 2243 tests passed.
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`

## Notes

- Existing misclassified database rows are not deleted or mutated; they follow the normal lifecycle thresholds.
- The installed Agent Deck instance was not restarted because it owns this session. Restart is required before runtime verification.
- Resolved app issue: `38fdc312-ee81-4ed6-a6b8-6e7e699f2919`.
- Related review: [REVIEW_146](../../reviews/recent-week/REVIEW_146_desktop-ephemeral-codex-hooks.md).
