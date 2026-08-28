---
plan_id: 42
completed_at: 2026-08-18
status: completed
---

# PLAN_42_summary-settings-layout-and-timeout-policy: Align generator settings

## Goal

Make the “会话续接上下文” and “间歇总结” panels follow one predictable field-ordering rule, and
remove per-summary timeout from user settings in favor of one generous application-owned deadline.

## Decisions

1. Both panels follow `purpose -> enablement -> triggers -> model -> maximum concurrency ->
   feature-specific controls or diagnostics`. Summary therefore moves its model card before the
   concurrency limit, matching continuation context.
2. Periodic summary generation uses one fixed five-minute timeout. Five minutes matches the current
   continuation checkpoint background/handoff budget, leaves normal providers ample time, and still
   releases a wedged scheduler slot.
3. `summaryTimeoutMs` is not retained as a hidden setting. It is removed from `AppSettings`, defaults,
   IPC behavior, Desktop/Local Worker projections, Server Core provider settings, node configuration,
   and every provider host port. Exact current schemas reject it.
4. Claude, Codex, and Grok runner cores consume `PERIODIC_SUMMARY_TIMEOUT_MS` directly, so Desktop and
   Server Core cannot drift or override the policy.

## Implementation

- Added the application-owned timeout constant to the shared summary policy surface.
- Removed the timeout input from Summary UI and moved “最多同时总结的会话数” below the model card.
- Added explicit field-order tests for both Summary and Continuation sections.
- Removed timeout plumbing from settings persistence projections, remote contracts, provider hosts,
  and adapter host interfaces; retained timeout cancellation/error handling inside the oneshot
  runners.
- Added negative current-schema coverage for persisted/provider/node payloads that still contain the
  removed setting, plus fixed-policy assertions for all three providers.

## Validation

- Focused integration: 18 files / 68 tests passed.
- `pnpm typecheck` passed architecture guards and Node/Web TypeScript.
- `pnpm test` passed 971 files / 6,138 tests; 2 files / 3 live or platform tests skipped.
- `pnpm build`, `pnpm check:deployment`, and `pnpm logger:check` passed.
- Production scans found no `summaryTimeoutMs`, `readSummaryTimeoutMs`, or timeout UI label.
- Full/scoped `git diff --check` and the 500-line guard passed.

## Final status

Completed. No commit, installation, deployment, database migration, or live-app restart was
performed. The bundled timeout and main-process contract changes are guaranteed on the next normal
launch.
