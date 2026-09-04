---
changelog_id: 511
changed_at: 2026-08-05
---

# CHANGELOG_511_claude-message-translation-state-core-boundary: Isolate translator state ownership

## Summary

Claude SDK message translation no longer imports the concrete session repository or event bus.
Model fallback, authoritative permission-mode synchronization, and compact-failure projection now
live behind an explicit host-neutral Core plus a narrow desktop host/facade.

## Host-neutral translation state Core

- Added `message-translation-state-core.ts` with application-before-session model fallback,
  fail-safe default bucketing, exact provider permission-mode validation, live-cache-first updates,
  bypass/default protection, changed-record persistence policy, and compact failure text.
- Preserved the prior nullish model precedence exactly: a present but blank application model falls
  back to the Claude default bucket rather than consulting a different session record.
- Preserved provider-only `dontAsk`, public selectable modes, no-op identical updates, and the
  `allowDangerouslySkipPermissions` default-report exception.

## Desktop host and stable facade

- Added `message-translation-state-host.ts` as the only owner of `sessionRepo` reads/writes and
  `session-upserted` event publication.
- Added `message-translation-state.ts` as the stable host-injection facade used by the translator.
- Reduced `sdk-message-translate.ts` from 488 to 443 lines while removing its concrete repository
  and event-bus imports; message/event behavior and existing call signatures remain unchanged.

## Direct evidence and executable gate

- Added direct Core tests for model precedence/default/error fallback, cache-before-persistence,
  changed/no-op mode updates, bypass protection, unknown modes, and compact failures.
- Added a desktop host test for repository reads, permission persistence, and updated-row
  publication; retained status/init/token/compact translator suites as integration evidence.
- Added direct-import rules excluding the facade/host, concrete desktop state, Node built-ins,
  Electron, and electron-log, plus the seventy-sixth executable Node 22 boundary candidate.

## Validation

- Focused Core/host/translator coverage: passed, 6 files / 36 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy-six Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 712 files / 4,978 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep translation-state Core, desktop host, stable facade, translator, architecture rule, and direct
plus integration tests together. Provider permission state must update the live cache before any
repository comparison, while an SDK `default` report must never erase an application-owned bypass.

## Remaining boundary

The translator's concrete persistence is isolated. Its clock/agent identity, runtime metadata and
live-rate hosts, event dispatch, file-change helpers, and stream processor composition still remain
before the complete provider output boundary can be executable-gated, alongside real
Linux/SSH/Feishu/provider acceptance.
