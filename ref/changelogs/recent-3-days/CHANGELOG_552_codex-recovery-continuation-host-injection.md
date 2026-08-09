---
changelog_id: 552
changed_at: 2026-08-05
---

# CHANGELOG_552_codex-recovery-continuation-host-injection: Inject Codex recovery continuation ownership

## Summary

The Codex SDK bridge no longer imports the desktop recovery continuation implementation. Capture,
preparation, and cleanup now flow through one provider-neutral host contract supplied by adapter
composition, preserving the existing SQLite/checkpoint/spool implementation on the desktop side.

## Shared continuation host

- Added `RecoveryContinuationHost` beside the provider-neutral recovery DTOs and runtime overrides.
- Added one desktop host that delegates to the authoritative continuation recovery service.
- Reused that host for Claude so both bridges share the same composition boundary and behavior.
- Required Codex adapter initialization to supply the host explicitly rather than relying on a
  hidden desktop singleton.
- Added an architecture rule that forbids the complete Codex bridge from importing either the
  desktop recovery implementation or its desktop host.

## Complete-bridge probe

- Probed the complete Codex SDK bridge as an executable Node 22 candidate.
- The initial bundle exposed the direct continuation recovery import; after this repair, the probe
  advanced to the remaining aggregate desktop ownership only: scoped diagnostics plus
  SessionManager/token lifecycle composition.
- Removed the intentionally failing probe candidate after recording that exact residual boundary,
  so the stable executable inventory remains 93 passing candidates.
- The next slice can therefore address one coherent aggregate Codex runtime host instead of
  guessing at additional leaf extractions.

## Preserved behavior

- Recovery capture remains synchronous and precedes mutable publication.
- Checkpoint/raw-tail preparation, immutable spool ownership, and idempotent cleanup retain the
  same authoritative desktop implementation and error behavior.
- Codex thread identity, recovery, cancellation, publication, app-server, and MCP token semantics
  are unchanged.
- Claude continues to delegate the same recovery operations through its existing recovery host.

## Direct evidence

- A Codex injection regression proves capture, preparation, and cleanup call only the supplied
  host.
- Adapter construction tests prove the desktop host is supplied at the composition boundary.
- Claude recovery-host coverage proves the shared desktop implementation remains wired there too.
- The complete-bridge bundle probe identified only logger and SessionManager/token ownership after
  the continuation repair; no model/settings or additional continuation leak remained.

## Validation

- Codex, Claude, and Core coverage: passed, 204 files / 990 tests.
- Node and web TypeScript plus architecture gates passed with 93 Node candidates.
- `mise exec -- pnpm build`: passed; main production bundle transformed 791 modules.
- Canonical Electron full suite: passed, 742 files plus 1 skipped / 5040 tests plus 1 skipped.
- `CodexSdkBridge` is 496 lines; `recovery-types.ts` is 56 lines.
- `git diff --check` passed and the cached Git index remains empty.
- No shared development or Electron process was stopped, restarted, or signalled.

## Do Not Split Protection

Keep the shared contract, desktop delegation, adapter injection, import prohibition, and Codex
injection regression together. Directly importing the desktop service would silently reintroduce
the checkpoint worker, SQLite store, and event-bus graph into the complete bridge.

## Remaining boundary

The complete Codex bridge still needs one aggregate runtime host covering scoped diagnostics,
SessionManager operations, and MCP token allocation/resolution/release across its nested
controllers. Re-add the complete-bridge candidate only after those exact dependencies are injected.
