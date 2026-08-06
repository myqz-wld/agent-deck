---
changelog_id: 532
changed_at: 2026-08-05
---

# CHANGELOG_532_claude-recovery-freshness-host-injection: Inject Claude freshness reads

## Summary

The Claude bridge facade no longer imports the desktop event repository. Recovery and cold-restart
transcript freshness checks now read the latest accepted conversation timestamp through one
required, read-only host supplied by adapter initialization.

## Narrow event-history ownership

- Added a Node-safe recovery-freshness contract containing only the latest conversation-message
  timestamp query needed by native-jsonl healing.
- Bound the concrete event repository only in the desktop freshness host.
- Made the host a required bridge option and threaded the exact object through the adapter-init
  Core and the unique desktop composition.
- Kept the protected bridge method as the existing test seam while changing its implementation to
  delegate to the injected host.

## Preserved freshness policy

- Restart and disconnect recovery still share the same timestamp source.
- The timestamp remains an optional lower bound: no accepted message returns `null`, while a newer
  conversation event continues to reject a stale native transcript and select bounded fallback.
- Jsonl existence/mtime probing, continuation capture, native-session identity, fallback recovery,
  and single-flight behavior are unchanged.

## Direct evidence and architecture gate

- Desktop-host coverage proves the exact session id reaches the event repository and the timestamp
  is returned without normalization.
- Adapter-init tests prove the exact freshness host reaches bridge construction.
- Existing real recovery and restart-precheck suites exercise native resume, stale/missing jsonl,
  fallback, and timestamp propagation through the injected bridge method.
- Expanded the bridge architecture rule to reject future desktop freshness-host or store imports.
- A direct import scan finds no store dependency in the Claude bridge facade.

## Validation

- Focused freshness/init/recovery coverage: passed, 5 files / 49 tests.
- Complete Claude adapter coverage: passed, 116 files / 487 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 728 files / 5,019 tests plus 1 skipped.
- `sdk-bridge/index.ts` is 498 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the freshness contract, desktop binding, required bridge option, facade delegation, tests, and
architecture rule together. A partial change could compare provider transcript mtime against a
different event repository from the one that supplied recovery state.

## Remaining boundary

The bridge's live provider switch still discovers Claude Gateway profiles through a desktop facade
instead of the already-injected create/default host. Reusing that authoritative host for validation
is the next small settings/composition seam before broader runtime-factory work.
