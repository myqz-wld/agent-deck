# REVIEW_128 — Codex quota read fails without an open Codex session

## Trigger

User report: when no Codex session is open, reading quota information logs an error. Application logs showed repeated background probe entries and Codex quota failures.

## Method

- Inspected `~/Library/Logs/Agent Deck/main-2026-06-18.log`.
- Ran a minimal JSON-RPC reproduction against `codex app-server --stdio` with `account/rateLimits/read`.
- Compared the shell `codex` binary and the installed app vendored Codex binary; both were `0.141.0`.
- Ran repeated calls in two modes: new app-server process per read versus one reused app-server process.

## Finding

### [MEDIUM fixed] Codex quota probe recreated the app-server process for every refresh

Evidence:

- Logs contained repeated probe cwd entries followed by:
  `failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)`.
- A direct one-shot call with either system Codex or the installed vendored Codex binary could succeed, proving that no live Agent Deck Codex session is required for background quota reads.
- Five repeated reads with a new app-server process produced one success followed by four `wham/usage` failures.
- Five repeated reads through one reused app-server process all succeeded.

Root cause:

`src/main/adapters/codex-cli/usage-snapshot.ts` disposed the background Codex app-server client after every provider usage read. Data tab refresh and startup preheat therefore repeatedly created fresh app-server processes for the same account quota endpoint, which is unstable under short-interval process churn.

Fix:

- Cache the background Codex app-server client and reuse it across quota refreshes.
- Dispose the cached client after five idle minutes.
- Invalidate the cached quota client when the Codex binary path setting changes.
- Downgrade known quota endpoint failures to `unavailable` rather than a generic error snapshot.

## Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/usage-snapshot.test.ts src/main/ipc/__tests__/provider-usage.test.ts src/main/adapters/__tests__/provider-usage.test.ts src/renderer/components/__tests__/DataPanel.test.tsx` — 18 passed.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- `git diff --check` — passed.

## Related Changelog

- `CHANGELOG_299`
