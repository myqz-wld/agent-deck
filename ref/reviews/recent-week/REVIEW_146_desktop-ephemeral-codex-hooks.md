---
review_id: 146
reviewed_at: 2026-07-10
baseline_commit: 9e6ee3a
expired: false
skipped_expired: []
---

# REVIEW_146_desktop-ephemeral-codex-hooks: Desktop ephemeral Codex hook boundary

## Scope

This review correlates the two unexpected external sessions with Agent Deck SQLite events, ChatGPT Desktop logs, process ancestry, Codex ephemeral-thread semantics, and the resulting hook-ingress implementation.

```review-scope
src/main/adapters/codex-cli/desktop-ephemeral-filter.ts
src/main/adapters/codex-cli/hook-routes.ts
src/main/adapters/codex-cli/__tests__/desktop-ephemeral-filter.test.ts
src/main/adapters/codex-cli/__tests__/hook-routes.test.ts
```

## Method

- Queried the live Agent Deck database read-only and correlated both session IDs with ChatGPT Desktop's Codex logs and PID ancestry.
- Confirmed the two stages were `ambient_suggestions` and `ambient_suggestion_safety`, not Agent Deck child sessions or duplicate ingestion.
- Compared 51 existing persisted external Codex starts with the two anomalies: persisted terminal sessions had transcript paths; both Desktop ambient threads explicitly reported null and had no rollout files.
- Checked the Codex app-server contract that ephemeral threads have no persisted path.
- Reviewed the filter for false positives, partial-ingestion races, lookup failures, cache behavior, platform differences, and hook latency.

## Gate Result

PASS.

Severity distribution:

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 2 fixed
- LOW: 1 dispositioned

## Findings and Decisions

### MEDIUM fixed: Desktop ambient tasks polluted the external terminal session list

The user-level Codex hooks were correctly global, but ChatGPT Desktop's hidden ephemeral generators also loaded them. With no Agent Deck SDK origin header, the route defaulted them to CLI and persisted two user-invisible background stages as external sessions for the one-hour active window.

Fix: decide at the Codex route boundary before translation or persistence, and acknowledge ignored hook requests with HTTP 200.

### MEDIUM fixed: transcript-null alone would hide legitimate terminal ephemeral runs

Codex intentionally supports ephemeral app-server threads with a null path. A filter based only on `transcript_path` would therefore suppress a user who explicitly launched an ephemeral Codex run from a terminal.

Fix: require explicit null plus a verified ChatGPT / Codex Desktop process pair. macOS requires child and parent to resolve to the same supported `.app` bundle; Windows requires a Codex app-server child and a ChatGPT / Codex Desktop executable parent.

### LOW dispositioned: upstream Desktop packaging may change

Desktop executable names and process ancestry are not a public stable API. An upstream packaging change can make classification return false.

Disposition: all uncertainty fails open, so the failure mode is renewed UI noise rather than hidden user activity. PID and session decisions are bounded and cached; unsupported platforms preserve all hooks.

## Lifecycle and Concurrency Checks

- The first hook fixes the decision for the entire session, preventing a missing field on one event from producing a half-persisted trajectory.
- Concurrent events share the same cached Promise.
- Positive and negative PID decisions share a five-minute cache; session decisions last 24 hours and both caches are capped at 512 entries.
- Process lookup exceptions and route-filter exceptions preserve the event.
- Existing `Stop` and lifecycle behavior is unchanged because `Stop` is turn-scoped, not a session-close signal.

## Validation

- Focused Codex hook / ingest suite: 5 files and 51 tests passed.
- Full suite: 205 files and 2243 tests passed.
- `pnpm typecheck`
- `pnpm build`
- `pnpm logger:check`
- `git diff --check`

## Residual Risk

- Windows process ancestry is covered with deterministic fixtures but was not exercised on a live Windows host in this macOS session.
- Existing anomalous rows remain until normal lifecycle progression or explicit user cleanup; the fix prevents new rows only after application restart.

## Related Records

- [CHANGELOG_355](../../changelogs/recent-week/CHANGELOG_355_filter-desktop-ephemeral-codex-hooks.md)
- App issue: `38fdc312-ee81-4ed6-a6b8-6e7e699f2919`
