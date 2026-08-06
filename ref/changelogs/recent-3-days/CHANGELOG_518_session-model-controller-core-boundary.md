---
changelog_id: 518
changed_at: 2026-08-05
---

# CHANGELOG_518_session-model-controller-core-boundary: Isolate model-option rollback

## Summary

The provider-neutral model-option controller shared by Claude, Codex, and Grok is now an
independently executable Core. Repository writes, session-updated publication, clock access, and
diagnostics are explicit desktop ports while the stable controller API remains unchanged.

## Controller Core

- Added `session-model-controller-core.ts` with the existing per-session operation serialization.
- Preserved provider/model/thinking snapshots and the working/waiting provider-switch admission
  fence before validation or persistence.
- Preserved validate-before-write ordering, dormant-session persistence, and exact live application.
- Preserved transactional repository rollback followed by best-effort live rollback when a provider
  rejects a partially applied change.
- Preserved fixed user-visible failure projection while moving its timestamp and diagnostics behind
  injected ports.
- Preserved exact operation-map cleanup after success or failure so later recovery/model changes can
  proceed.

## Desktop host and stable facade

- Added `session-model-controller-host.ts` as the sole owner of `sessionRepo`, `eventBus`, desktop
  time, and logger access.
- Reduced `session-model-controller.ts` to a 14-line stable facade used unchanged by Claude, Codex,
  and Grok bridges.

## Direct evidence and executable gate

- Added direct Core coverage for dormant persistence and slot release, persisted/live rollback with
  an injected clock, and active-provider admission before mutation.
- Retained the shared facade suite and the Codex live-thread integration suite.
- Added a direct-import rule rejecting the stable facade/host and concrete session, repository,
  event-bus, runtime-host, and logger dependencies, plus the eighty-third Node 22 candidate.

## Validation

- Focused Core/facade/provider coverage: passed, 3 files / 25 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed eighty-three Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 719 files / 4,999 tests plus 1 skipped.
- `git diff --check`, the empty cached-index gate, direct-import scan, and changed-file line guard
  passed.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep controller Core, desktop host, stable facade, architecture rule, and direct plus provider tests
together. Persistence must precede live application; a failure after either attempt must restore the
old repository values and then best-effort restore the old live selection.

## Remaining boundary

Model-option persistence is host neutral across providers. The remaining bridge composition and
provider settings/repository ownership can be inventoried independently before real platform and
provider acceptance.
