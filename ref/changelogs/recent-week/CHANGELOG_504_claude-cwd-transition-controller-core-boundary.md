---
changelog_id: 504
changed_at: 2026-08-05
---

# CHANGELOG_504_claude-cwd-transition-controller-core-boundary: Port cwd replacement state

## Summary

Claude live-session cwd replacement and rollback now run in a host-neutral Core. The authoritative
desktop session repository remains behind one host while arming, continuation capture, runtime
replacement, queue restoration, rollback, and release behavior stay stable.

## Host-neutral cwd transition Core

- Added `cwd-transition-controller-core.ts` with generation arming/release, active-turn and current-cwd
  gates, target/source continuation capture, close-before-recreate sequencing, and cleanup barriers.
- Preserved fail-closed target failure behavior: rebuild the original cwd from a separately prepared
  continuation, report restored failure, and aggregate both errors if rollback also fails.
- Preserved pending user-message migration and bounded enqueue-fingerprint merge order, including
  rejection when a replacement reuses an accepted key for a different payload.
- Preserved provider, agent/plugin, permission, sandbox, writable-root, model, and valid Claude
  thinking metadata across both target and rollback runtime creation.

## Thin desktop host and stable facade

- Added `cwd-transition-controller-host.ts` as the sole owner of authoritative `sessionRepo.get`.
- Reduced `cwd-transition-controller.ts` to a stable subclass facade that injects the desktop host;
  existing bridge construction and public controller methods remain unchanged.
- Added direct Core tests for generation ownership/release, active-turn and unarmed rejection,
  current-target no-op, and missing persistence; retained target/rollback integration tests and added
  a direct repository-host test.

## Executable boundary gate

- Added a direct-import rule rejecting the stable controller, desktop host, concrete stores,
  runtime hosts, Node built-ins, Electron, and electron-log from cwd transition Core.
- Added Claude cwd transition controller Core as the sixty-ninth executable Node 22 boundary
  candidate.

## Validation

- Focused Core/host, facade transition, and worktree coordination coverage: passed, 5 files / 12
  tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixty-nine Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 703 files / 4,946 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep cwd transition Core, desktop host, stable facade, direct-import rule, and target/rollback tests
together. Runtime replacement must close before recreate, both captures must always clean up, queued
messages/idempotency must survive replacement, and rollback must remain source-cwd fail closed.

## Remaining boundary

Claude cwd transition state and rollback are now host neutral. The wider provider output stream plus
concrete provider composition/repository ownership remain, alongside real
Linux/SSH/Feishu/provider acceptance.
