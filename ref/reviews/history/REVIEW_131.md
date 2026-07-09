# REVIEW_131

## Trigger Context

User asked to inspect recent app logs, focus on warning/error entries, optimize anything worth fixing, then run a simple review including the earlier directory picker, quota cadence, and Codex create-session changes.

## Log Evidence

Reviewed `~/Library/Logs/Agent Deck/main-2026-06-17.log` through `main-2026-06-19.log`.

Recent actionable patterns:

- Monaco worker CDN load failure on 2026-06-19 15:32:15:
  - `Could not create web worker(s). Falling back to loading web worker code in main thread`
  - `https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/...css.worker... failed to load`
- Codex quota app-server disposed warnings on 2026-06-19 between 16:34 and 17:34:
  - `[codex-usage] usage snapshot failed: Error: Codex app-server disposed`

Non-actionable or already-covered patterns:

- `Error sending from webFrameMain: Render frame was disposed` appeared heavily on 2026-06-17; current logger already has a file-transport filter and tests for this Electron framework noise.
- External provider/account conditions such as Claude 401, session limits, prompt-too-long, and Codex `wham/usage` fetch failures were left as real user/environment signals.
- Monaco unmount race warnings on 2026-06-18 are already suppressed to debug by current code.

## Findings

### MEDIUM: Monaco workers attempted CDN loading and fell back to the main thread

Status: fixed.

Impact:

- Offline / blocked CDN causes renderer errors and Monaco falls back to main-thread worker code, which can cause UI freezes.

Fix:

- Added a lazy local Monaco worker helper.
- DiffEditor and LogViewer configure local workers before importing `@monaco-editor/react`.
- Removed jsdelivr from renderer CSP.

### MEDIUM: Codex usage cached app-server idle timer could dispose an in-flight reused quota read

Status: fixed.

Impact:

- The 5-minute background refresh can reuse the cached app-server near the same time the idle timer fires, producing `Codex app-server disposed` warnings and failed quota snapshots.

Fix:

- Reusing the cached Codex usage client now clears the idle timer before starting the request.
- The timer is rescheduled only after the read completes.

## Validation

- Codex usage snapshot tests passed: 5 tests.
- Targeted regression set passed: 7 files, 36 tests.
- `pnpm typecheck` passed.
- `pnpm build` passed and emitted local Monaco worker assets.
- `git diff --check` passed.

## Related Changelog

CHANGELOG_311.
