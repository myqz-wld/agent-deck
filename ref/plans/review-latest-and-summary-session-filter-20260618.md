---
plan_id: review-latest-and-summary-session-filter-20260618
created_at: 2026-06-18
worktree_path: /Users/wanglidong/Repository/agent-deck
status: completed
base_commit: 84cba1080cc2aa156276be20343f83eabd36f6f0
---

# Goal

Solo-review the latest commit for regressions and fix any concrete issues found. Separately, locate and fix the bug where the real-time session list keeps creating external Codex sessions, likely by failing to filter internal summarizer/probe sessions.

# Invariants

- Do not start reviewer agents; this is a solo review per user request.
- Do not revert unrelated local changes.
- Internal summary/probe/usage sessions must not be inserted or shown as external user sessions.
- Real external Codex sessions must still be discoverable.
- Latest commit UI overlay behavior must remain intact unless a review finding requires a focused correction.

# Checklist

- [x] Read repository workflow and relevant Codex session conventions.
- [x] Read relevant changelog/review history for provider usage and hidden subprocesses.
- [x] Inspect latest commit diff and identify any regressions.
- [x] Trace external Codex realtime-list discovery and session insertion.
- [x] Add a focused filter/test for internal summary/probe sessions.
- [x] Apply any latest-commit review fixes if needed.
- [x] Run focused tests and typecheck where practical.
- [x] Record final review/changelog notes required by the repo workflow.

# Current Evidence

- Latest commit `84cba1080cc2aa156276be20343f83eabd36f6f0` changed expanded diff overlay rendering and bumped Claude/Codex SDK packages.
- `REVIEW_115` / `CHANGELOG_262` established the existing invariant that data/usage reads must not start hidden provider child processes.
- Latest commit regression found and fixed: `package.json` bumped Claude Agent SDK / Codex, but `pnpm-lock.yaml` still pinned old versions.
- Root cause for repeated external Codex sessions: app-managed Codex app-server children inherited global hooks without `AGENT_DECK_ORIGIN=sdk`, so the existing SDK-origin hook drop guard could not distinguish summary/probe/live internal children from terminal sessions.
- Root cause for external close mismatch: current Codex `Stop` is turn-scoped and Codex has no current release `SessionEnd` hook. PID/process-exit inference is also unsafe because hook runners can be turn-scoped.

# Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/hook-translate.test.ts src/main/adapters/codex-cli/__tests__/hook-installer.test.ts src/main/adapters/codex-cli/__tests__/hook-routes.test.ts src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/codex-instance-pool.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.early-err-cleanup.test.ts src/main/session/__tests__/manager-ingest.test.ts`
- `pnpm typecheck`
- `pnpm test` (174 files passed, 1956 tests passed)

# Risks

- Filtering too broadly could hide legitimate external Codex sessions; covered by filtering only `source='hook' && hookOrigin='sdk'` while leaving external hook events without SDK origin claimable.
- Filtering only the renderer list could leave ghost sessions in DB; fixed at app-managed child env and ingest boundary instead.
- Treating Codex `Stop` as session-end would close still-open interactive terminals at every completed turn; fixed by leaving Stop as `finished`.
- Treating PID exit as session-end can still close a resumable external session if the PID belongs to a delayed turn runner; fixed by not driving lifecycle from PID inference.

# Next-session First Action

No follow-up session required unless new runtime logs show another external-session source.
