---
changelog_id: 554
changed_at: 2026-08-05
---

# CHANGELOG_554_grok-build-bridge-runtime-host-boundary: Bundle the complete Grok bridge

## Summary

The complete Grok Build bridge is now an executable Node 22 boundary candidate. One required
runtime host supplies its desktop-owned session records, transactions, publication, handoff and
worktree authority, diagnostics, and live token-rate observation without changing provider behavior.

## Aggregate runtime host

- Added a host-neutral contract for Grok session-record reads and writes, atomic persistence,
  session publication, handoff admission, worktree-transition detection, scoped diagnostics, and
  live token-rate observation.
- Added one desktop composition that delegates to the authoritative SQLite repository, event bus,
  handoff/worktree registries, logger, and token-rate event observer.
- Threaded the required host through create, resume, recovery, startup, model/mode mutation,
  transport recycling, response finalization, context refresh, and message ingress.
- Kept small unit contexts explicit with a no-op host and added a reusable test host whose nested
  record/effect ports can be replaced independently.

## Complete-bridge boundary

- Added the complete Grok Build bridge to the executable Node 22 bundle gate.
- Increased the stable candidate inventory from 94 to 95.
- Removed transitive desktop ownership through the repository, event bus, logger, live-rate host,
  handoff ingress guard, and worktree registry from the bridge dependency graph.
- Expanded the architecture rule so only desktop adapter composition may import those concrete
  hosts; the bridge itself must consume the injected runtime contract.
- Moved initial-turn projection into a focused Core helper and kept changed ordinary sources below
  the repository's 500-line limit.

## Preserved behavior

- Grok ACP create/load identity, initial-turn ordering, recovery, model/mode/sandbox persistence,
  usage-watermark durability, transport recycle, and lifecycle claims remain unchanged.
- Handoff buffering and worktree-transition queue forcing still use the same authoritative desktop
  registries, now reached through explicit ports.
- Live token-rate state now stores the injected observer with each translation state, so create and
  recovered runtimes retain the exact desktop event publication behavior without importing it.
- This slice has no user-visible UI or protocol change.

## Validation

- Complete Node boundary gate: passed, 95 executable candidates.
- Grok adapter coverage: passed, 40 files / 219 tests.
- Node and web TypeScript plus architecture gates passed.
- `mise exec -- pnpm build`: passed; main production bundle transformed 792 modules.
- Canonical Electron full suite: passed, 743 files plus 1 skipped / 5041 tests plus 1 skipped.
- `bridge.ts` is 499 lines, `turn-queue.ts` is 498 lines, `bridge-runtime-core.ts` is 77 lines,
  and `bridge-runtime-host.ts` is 39 lines.
- `git diff --check` passed and the cached Git index remains empty.
- No shared development or Electron process was stopped, restarted, or signalled.

## Do Not Split Protection

Keep the aggregate contract, desktop composition, adapter injection, message-ingress ports,
translation observer ownership, architecture prohibition, test fixture, and complete-bridge
executable candidate together. Removing any one would either restore a hidden desktop dependency or
leave the boundary unproved.

## Remaining boundary

The next extraction target is the concrete adapter set, provider settings, and business repository
composition needed by the injected Electron-free Server Core runtime. Real Linux/native packaging,
SSH/Podman/systemd acceptance, and live Feishu/provider acceptance remain explicit environment gates.
