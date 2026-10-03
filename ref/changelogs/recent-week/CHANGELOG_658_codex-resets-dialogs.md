---
changelog_id: 658
changed_at: 2026-09-29
---

# Codex quota resets and consistent application dialogs

## Summary

The usage panel displays available Codex reset credits on a compact single line.
Using a credit requires the approved short confirmation, then refreshes usage and
counts from the provider. Application confirmations share one compact dialog.

## Changes

- Preserve `rateLimitResetCredits.availableCount` from ordinary Codex usage reads.
  Pass `excludeResetCreditDetails: true` to avoid a separate credit-detail request.
  Keep missing, unknown, zero, and positive counts distinct. Claude and Grok have
  no reset actions because their current integrations expose no verified contract.
- Route consumption through Codex's `account/rateLimitResetCredit/consume`.
  Check account affinity before redemption, serialize concurrent attempts, retain
  the same idempotency key across ambiguous retries and view changes, and handle
  all four documented outcomes without guessing which quota windows changed.
- Add validated Local IPC and Remote Core request/result contracts. Remote writes
  require the expected authority and a mutation grant. Append the method to the
  grant directory without reordering existing wire bits. Invalidate outstanding
  cache generations before and after a mutation.
- Render the reset count and action in one row using 10px copy. Hide use actions
  when counts or the current source are unavailable; refresh after consumption.
- Replace all renderer native confirmations with a queued application dialog:
  title, necessary explanation, Cancel, and an action-specific confirmation.
  Default keyboard focus to Cancel and preserve destructive action coloring.
- Share surfaces across ten form/content dialog frames, keep specialized full-screen
  viewer layouts, and integrate image, diff, and composer overlays with the common
  modal layer. Escape closes the top layer; focus returns to its initiating control.
- Preserve existing sandbox and approval switching triggers. In particular, Codex
  `never` remains a direct setting change, as explicitly requested by the user.

## Validation

- `pnpm typecheck`: passed, including architecture boundaries.
- Full suite through the `pnpm test` Electron runner with 4 workers: 1,094 files,
  6,758 passing tests, 3 pending tests, zero failures.
- `pnpm build`: passed for main, preload, and renderer.
- Agent Deck Browser rendered the actual React quota and confirmation components
  with synthetic data. Confirmed a 10px single count row, cancel/confirm behavior,
  successful simulated refresh, destructive confirmation styling, and no console
  errors. Only local preview assets were requested.
- Provider query contracts were verified by actual read-only calls; no real credit
  was consumed and no runtime permission or sandbox setting was changed.

## Do Not Split Protection

`src/main/adapters/codex-cli/sdk-bridge/index.ts` remains a 503-line facade. Reset
implementation was extracted to `usage-reset.ts` and existing host/registry
boundaries; the facade adds only typed delegation. Further splitting would move
unrelated session lifecycle/test seams for this small forwarding change. Revisit
when another bridge responsibility or public method is introduced.

## Related records and activation

- [Implementation plan](../../plans/recent-week/PLAN_67_codex-resets-dialogs.md)
- [Dialog and reset validation](../../reviews/recent-week/REVIEW_298_dialogs-quota-reset-safety.md)
- Main/preload changes require the application to restart. No live Agent Deck
  process was stopped, restarted, replaced, or installed over during this work.
