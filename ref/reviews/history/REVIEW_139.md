# REVIEW_139

## Trigger Context

The user asked to apply the recent app-log recommendations and supplied a second machine's runtime log excerpt.

Relevant patterns:

- Repeated Codex quota warnings:
  `chatgpt authentication required to read rate limits (code -32600)`.
- Repeated SDK-derived orphan hook drops from hidden provider probes.
- Claude `jsonl-fallback precheck MISS` entries on recover/restart paths.
- A Claude-session summary timeout with the Codex summarizer timeout marker.

## Findings

### LOW fixed: Codex quota auth failures were not classified as expected unavailability

The background quota classifier matched `auth` as a standalone token, but not `authentication required`. That left ChatGPT-login-required quota reads on the warning path even though the provider data is simply unavailable until the user logs in.

Fix:

- Added `authentication required` to the expected-unavailable classifier.
- Added regression coverage for the exact log message shape from the second machine.

### LOW fixed: Live Codex quota reads did not share the background unavailable mapping

When a live Codex app-server client existed, `CodexSdkBridge.getUsageSnapshot()` bypassed the background helper and returned `error` plus a warning for known quota endpoint/auth failures.

Fix:

- Exported the Codex expected-unavailable helper and unavailable snapshot builder.
- Live Codex quota reads now log expected failures at `debug` and return `unavailable`.
- Added a live-client regression test for `chatgpt authentication required`.

### LOW fixed: SDK-derived orphan hook drops were noisy at `info`

The log excerpt and local logs showed many expected `drop sdk-derived orphan hook` entries. The branch is intentionally dropping hook events from SDK-owned helper processes; it should remain visible in dev diagnostics but not fill the default file log.

Fix:

- Changed that branch from `logger.info` to `logger.debug`.
- Existing ingest tests continue to cover the behavioral drop.

### LOW fixed: logger guard still found renderer console warnings

`pnpm logger:check` reported renderer startup warning calls and one logger comment containing a literal console-call expression. These were not introduced by the Codex quota change, but they are directly in the logging hygiene path.

Fix:

- Converted the renderer startup preload and pending-request warnings to scoped renderer loggers.
- Rephrased the logger comment so the grep guard no longer treats it as a console call.

## Non-Fixes

- `claude-jsonl-fallback precheck MISS` remains a warning by design. CHANGELOG_223 documents it as the diagnostic marker for a missing Claude transcript before fresh-cli fallback. The supplied log shows the fallback path continuing to create a new SDK session.
- `__codex_summarizer_timeout__` on a Claude session is consistent with the current global `summaryProvider` design: a Claude session can be summarized by the Codex provider and then fall back to the last message.

## Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts src/main/session/__tests__/manager-ingest.test.ts src/renderer/hooks/__tests__/use-startup-data-preload.test.tsx` — 37 passed.
- `pnpm typecheck` — passed.
- `pnpm logger:check` — passed after the renderer logger cleanup.
- `git diff --check` — passed.

## Related Changelog

CHANGELOG_322.
