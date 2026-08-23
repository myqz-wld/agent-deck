---
changelog_id: 607
changed_at: 2026-08-13
---

# CHANGELOG_607_remote-ui-runtime-convergence: Reuse Local UI and restore Remote background data

## Summary

Remote now reuses the Local Settings and Session Detail presentation instead of maintaining
simplified copies. Relay and Full also share working summary and context-checkpoint services, while
reconnects reload current assets and session data without accepting stale responses.

## Changes

### Shared Settings and Session Detail

- Render Remote Settings through the same lifecycle, continuation, summary, Hook, external-tool,
  experiment, collaboration, notification, window, shortcut, and log sections used by Local.
- Keep remote-owned values visible but read-only; retain safe placeholders for secrets, paths, or
  actions that must remain on the host.
- Use the same permission panels for Claude, Codex, and Grok, including the same field sequence and
  unavailable states.
- Share Session Detail header, tab schema, cards, runtime fields, composer structure, pending rows,
  and handoff frame so source differences no longer redefine the page.
- Replace visible implementation jargon with descriptions centered on the user's computer, the
  remote computer, and when a change takes effect.

### Assets and reconnect behavior

- Present the same effective built-in Agent model, thinking, provider, tools, and override values
  for Local and Remote without duplicating or editing host configuration from the Remote page.
- Scope asset, detail, and presentation loads to the active connection generation; reconnecting can
  issue a fresh read immediately and late responses from the previous connection are ignored.
- Preserve long runtime values in narrow cards by wrapping rather than clipping them.
- Resolve Agent defaults before capability validation so configured gateways/providers launch with
  the same revision that was displayed.

### Relay and Full runtime

- Extend the shared node configuration contract with the settings required by the aligned page.
- Start summary and continuation-checkpoint production in the common Server Core composition used
  by both Relay Worker and Full.
- Apply configured intervals, limits, model selection, and raw-history retention to generated
  checkpoints and handoff.
- Add headless one-shot provider paths without importing desktop-only state, publish summary
  changes to open Remote views, and drain background work before shutdown.

## Validation

- Three parallel audits covered Settings fields, all Session Detail surfaces, and the complete
  summary/checkpoint data path.
- Field-level parity tests cover Local/Remote Settings and Claude/Codex/Grok permissions, including
  missing and malformed data.
- pnpm typecheck, the full Electron suite (6,176 passed, 0 failed, 3 environment skips),
  pnpm build, and git diff --check passed.
- The production renderer loaded without console errors in a browser. Live Electron screenshot
  coverage was unavailable because the active application owns the single-instance lock; no
  synthetic page was treated as a live Remote UI check.

## Do Not Split Protection

No production-file exception is required. Shared presentation, transport fencing, summary, and
checkpoint responsibilities are split into focused modules and every touched production
TypeScript file remains below 500 lines.

## Related review

- ref/reviews/recent-3-days/REVIEW_241_remote-ui-runtime-convergence.md

