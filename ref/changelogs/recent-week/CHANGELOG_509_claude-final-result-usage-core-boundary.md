---
changelog_id: 509
changed_at: 2026-08-05
---

# CHANGELOG_509_claude-final-result-usage-core-boundary: Gate usage reconciliation Core

## Summary

Claude progressive assistant usage and cumulative final-result reconciliation now have an explicit
host-neutral Core boundary. The stable module remains a re-export facade, so translator and result
outcome callers keep their existing API and token-accounting semantics.

## Host-neutral usage Core

- Added `final-result-usage-core.ts` with progressive message watermarks, per-turn model buckets,
  cumulative aggregate/model watermarks, resumed-session baselines, and positive-delta correction.
- Preserved assistant-vs-final subtraction, provider counter-reset handling, cache token metrics,
  single-model reasoning attribution, and multi-model unattributed-reasoning rows.
- Preserved fail-safe reconciliation: malformed provider totals cannot break message translation,
  the live output rate retains observed assistant output, and every result clears the baseline flag.

## Stable facade and direct evidence

- Reduced `final-result-usage.ts` to value/type re-exports from Core; existing imports in translator
  and result-outcome modules remain unchanged.
- Added direct Core tests for progressive max watermarks, missing assistant IDs, exactly-once final
  deltas, resumed baseline adoption, subsequent growth, and multi-model reasoning attribution.
- Retained the full translator token/context/live-rate suites as integration evidence.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, concrete stores/event/runtime utilities,
  Node built-ins, Electron, and electron-log from final-result usage Core.
- Added Claude final-result usage Core as the seventy-fourth executable Node 22 boundary candidate.

## Validation

- Focused Core/translator/thinking/live-rate coverage: passed, 5 files / 38 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy-four Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 709 files / 4,967 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep final-result Core, stable re-export facade, metric-scope helper, direct-import rule, and direct
plus translator tests together. Progressive rows, cumulative results, resumed baselines, counter
resets, and multi-model reasoning must never double count or erase positive observed usage.

## Remaining boundary

Claude final-result usage reconciliation is now host neutral and executable-gated. The broader
provider output translator/stream processor plus concrete create/recovery composition and repository
ownership remain, alongside real Linux/SSH/Feishu/provider acceptance.
