---
changelog_id: 492
changed_at: 2026-08-05
---

# CHANGELOG_492_claude-native-fork-core-boundary: Port native fork orchestration

## Summary

Claude-family native-fork transcript discovery, boundary selection, SDK materialization, child
resume, and rollback now execute in an Electron-free Node Core. A thin desktop host supplies only
the installed SDK, Claude configuration root, child-session repository, and cleanup observer.

## Host-neutral native-fork Core

- Added `fork-session-core.ts` with complete-record JSONL parsing, active-chain/raw-provenance
  matching, worktree-aware transcript discovery, ambiguity/partial-chain fail-closed behavior, and
  safe top-level user-boundary selection.
- Preserved inclusive SDK fork semantics, source/native identity collision fences, child native-ID
  discovery, exactly-once discard ownership, and aggregate create-plus-cleanup failure authority.
- Reused the host-neutral cleanup Core directly so transcript and SDK orchestration cannot regain a
  desktop logger, event bus, repository singleton, or stable-facade dependency.

## Thin desktop host and stable facade

- Added `fork-session-host.ts` as the sole production owner of SDK loading, configuration-root
  discovery, the child session repository, and redacted cleanup observation.
- Reduced `fork-session.ts` to a stable typed Core/Host wrapper, preserving every existing adapter
  import, exported transcript helper, and deterministic test seam.
- Added direct Core and desktop-host tests alongside the existing transcript, lifecycle, rollback,
  identity, and adapter wiring suite.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade, desktop hosts, SDK loader, sessions,
  repositories, diagnostics, Electron, and electron-log from native-fork Core.
- Added Claude native-fork Core as the fifty-seventh executable Node 22 boundary candidate.

## Validation

- Focused Core/host, transcript/lifecycle, and adapter coverage: passed, 4 files / 19 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed fifty-seven Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 680 files / 4,898 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep native-fork Core, desktop host, stable facade, cleanup Core/observer, direct-import rule, and
transcript/lifecycle/rollback tests together. A fork must never guess between transcript copies,
drop a newer user frame, reuse a source identity, or let cleanup diagnostics change rollback
authority.

## Remaining boundary

Claude native-fork orchestration is now host neutral. Message/permission streaming and concrete
provider composition/repository ownership remain, alongside real Linux/SSH/Feishu/provider
acceptance.
