---
changelog_id: 551
changed_at: 2026-08-05
---

# CHANGELOG_551_claude-sdk-bridge-node-boundary: Bundle the complete Claude SDK bridge

## Summary

The complete Claude SDK bridge now passes the executable Node 22 boundary gate. Recovery
continuation capture, preparation, and cleanup no longer pull desktop checkpoint workers, SQLite
stores, or the event bus through the bridge composition graph.

## Continuation ownership

- Extracted the provider-neutral recovery continuation DTO and runtime-override contracts into
  `recovery-types.ts`; the existing desktop recovery service re-exports them for compatibility.
- Extended the existing Claude recovery host with exact capture, prepare, and cleanup operations.
- Kept SQLite/spool/checkpoint implementation in the desktop host while the bridge delegates only
  through its injected option.
- Updated Claude and Codex Core type consumers to reference the side-effect-free contract module.
- Added a direct architecture prohibition against importing the desktop recovery implementation
  from the complete Claude bridge.

## Complete executable boundary

- Added `claude-sdk-bridge-core` with no external package exemption.
- The candidate transitively covers create, disconnect recovery, restart, stream processing,
  pending responses, lifecycle, runtime model changes, usage reads, cwd transitions, and message
  ingress under one bridge class.
- Raised the executable Node boundary inventory from 92 to 93 candidates.

## Preserved behavior

- Recovery snapshots are still captured synchronously before mutable user publication.
- Bounded checkpoint/raw-tail preparation, immutable spool ownership, and idempotent cleanup retain
  the same desktop implementation and exception authority.
- Existing protected bridge seams remain available for deterministic subclass tests.
- No session identity, persistence, recovery, cancellation, publication, SDK, or renderer behavior
  changed.

## Direct evidence

- The first complete-bridge bundle attempt deterministically exposed the checkpoint worker/store
  path; the repaired bundle passes without an alias, external, or transform exemption.
- A new injection regression proves bridge capture, preparation, and cleanup call only the supplied
  recovery host.
- The desktop-host regression proves all three operations delegate to the authoritative recovery
  service alongside freshness reads and best-effort diagnostics.
- Canonical Electron focused coverage executes the SQLite-backed recovery tests rather than relying
  on the system-Node ABI skip path.

## Validation

- Canonical Electron recovery coverage: passed, 7 files / 107 tests.
- Claude plus Core coverage: passed, 130 files / 512 tests.
- Node and web TypeScript plus architecture gates passed with 93 Node candidates.
- `mise exec -- pnpm build`: passed; main production bundle transformed 790 modules.
- Canonical Electron full suite: passed.
- `ClaudeSdkBridge` is 496 lines; `recovery-types.ts` is 42 lines.
- `git diff --check` passed and the cached Git index remains empty.
- No shared development or Electron process was stopped, restarted, or signalled.

## Do Not Split Protection

Keep the recovery contract extraction, desktop-host delegation, bridge import prohibition,
injection regression, and complete bridge candidate together. A leaf-only gate would not detect a
future bridge import that silently reintroduces the worker/store composition graph.

## Remaining boundary

Claude's complete SDK bridge is now executable outside Electron. The next bounded slice should
probe the complete Codex SDK bridge, inventory its concrete desktop session/client/configuration
ownership, and introduce one aggregate host boundary without changing Codex runtime semantics.
