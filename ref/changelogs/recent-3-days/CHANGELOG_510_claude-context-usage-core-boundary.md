---
changelog_id: 510
changed_at: 2026-08-05
---

# CHANGELOG_510_claude-context-usage-core-boundary: Gate context attribution Core

## Summary

Claude assistant context counters and finalized context-window attribution now have an explicit
host-neutral Core boundary. The stable module remains a re-export facade, so SDK message translation
keeps its existing API while no longer reaching the desktop runtime-metadata facade.

## Host-neutral context usage Core

- Added `context-usage-core.ts` with non-negative assistant counter normalization, concrete runtime
  identity projection, exact primary-model window attribution, and Gateway alias mapping.
- Preserved fail-closed ambiguity rules: alias-only identities, missing or non-positive windows,
  multiple matching provider entries, and fallback/subagent-only usage do not claim capacity.
- Reused `resolveClaudeRuntimeModelCore` directly instead of importing the desktop metadata sync
  facade and its repository/event-bus host.

## Stable facade and direct evidence

- Reduced `context-usage.ts` to value/type re-exports from Core; existing translator imports remain
  unchanged.
- Added direct Core tests for counter normalization, concrete-vs-alias identity projection, Gateway
  alias mapping, ambiguous attribution, and finalized window payloads.
- Retained SDK translator token/context and compact-boundary suites as integration evidence.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop runtime-metadata host/sync,
  concrete stores/event/runtime utilities, Node built-ins, Electron, and electron-log.
- Added Claude context usage Core as the seventy-fifth executable Node 22 boundary candidate.

## Validation

- Focused Core/translator/runtime-metadata coverage: passed, 5 files / 30 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy-five Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 710 files / 4,972 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep context usage Core, stable re-export facade, runtime-model resolver, direct-import rule, and
direct plus translator tests together. Provider model usage must never infer a primary window from
equal bucket sizes, fallback/subagent rows, an alias-only identity, or more than one match.

## Remaining boundary

Claude context/window attribution is now host neutral and executable-gated. The broader SDK message
translator still owns concrete model fallback, permission-mode persistence, live-rate host wiring,
and provider output dispatch; those seams remain before provider composition/repository ownership
and real Linux/SSH/Feishu/provider acceptance.
