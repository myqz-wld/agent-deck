# REVIEW_135

## Trigger Context

User reported: "额度窗口有时候会刷到历史的数据" ("the quota window sometimes refreshes to historical data").

## Method

Targeted local review of the provider quota snapshot path:

- DataPanel quota refresh and manual hard refresh.
- App-level startup/background quota refresh.
- Token usage renderer store.
- Main-process provider usage IPC cache and in-flight dedupe.
- Existing provider-usage cache/refresh plan and recent quota changelogs/reviews.

No multi-agent review was used because the issue was a narrow race with focused regression coverage.

## Findings

### MEDIUM: Older quota reads could overwrite newer quota results

Status: fixed.

DataPanel and the app-level background refresh both wrote directly to the same renderer store. If an older automatic quota request finished after a newer manual refresh, the older response could write stale quota windows back into the UI.

Fix:

- The renderer token usage store now assigns a monotonically increasing provider-usage request id to each quota read.
- Success/error/finish actions only apply when their request id is still the latest.
- Startup background refresh and DataPanel refresh both use the same request-id gate.

Regression coverage:

- `DataPanel.test.tsx` now starts an older automatic refresh, starts a newer manual refresh, resolves the newer one first, then resolves the older one and verifies the displayed quota percentage stays on the newer result.

### MEDIUM: Manual hard refresh could reuse an older normal in-flight read

Status: fixed.

`providerUsageSnapshotHandler({ force: true })` skipped the TTL cache but still returned any existing `inFlightFetch`, including a normal background refresh started earlier. That made a manual hard refresh unable to force a fresh provider read in this race shape.

Fix:

- Main provider usage IPC now tracks normal and forced in-flight reads separately.
- Non-forced reads reuse a forced read when one is already running.
- Forced reads join only other forced reads.
- Main cache writes include a fetch sequence id, so an older read that finishes late cannot overwrite a newer cached result.
- Silent renderer background reads reuse an active foreground request id while a loading request is pending, so a background tick cannot steal the foreground refresh's result/error handling.

Regression coverage:

- `provider-usage.test.ts` now starts a normal refresh, starts a forced refresh before the normal one resolves, resolves the forced one first, then resolves the older normal one and verifies the main cache still returns the forced result.
- `provider-usage.test.ts` also verifies that a non-forced read joins an in-flight forced refresh before consulting a fresh cache.

## Validation

- Targeted Vitest set passed: 3 files, 15 tests.
- `pnpm typecheck` passed.
- `git diff --check` passed.

## Related Changelog

CHANGELOG_315.
