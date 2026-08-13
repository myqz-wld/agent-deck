---
changelog_id: 526
changed_at: 2026-08-05
---

# CHANGELOG_526_claude-stream-session-manager-boundary: Inject Claude stream ownership

## Summary

Claude stream finalization and provider-session identity adoption no longer import the desktop
SessionManager singleton. The bridge now passes its adapter-owned manager port through
`StreamProcessor` into one aggregate stream host.

## Stream ownership injection

- Extended the Claude manager port with `renameSdkSession` and `updateCliSessionId`, preserving the
  existing claim-release and persistence argument contracts.
- Replaced the finalizer and identity singleton hosts with factories that accept the smallest exact
  manager subsets.
- Made the aggregate stream host accept the combined manager subset and wired the bridge-owned port
  into every `StreamProcessor` construction.
- Updated affected stream fixtures to supply explicit manager ports rather than relying on module
  import side effects.

## Preserved lifecycle and identity ordering

- Stream terminal cleanup still releases the SDK claim only after the finalizer has resolved the
  authoritative terminal state and cleaned private settings.
- New-spawn identity adoption still moves the application session record before publishing the
  provider id, while resume and fresh-CLI reuse update only the stored CLI identity.
- Phantom runtime ids remain fenced and warning-only; no manager mutation is introduced on that
  path.
- The port is the exact same object used by create-session and recovery, preventing claim and
  provider-identity mutations from reaching different manager instances.

## Direct evidence and architecture gate

- Added a host-level delegation test covering claim release, session rename, CLI-id update, and
  diagnostic forwarding.
- Expanded the manager-port test and all direct `StreamProcessor` fixtures for the two new methods.
- Added static rules rejecting future direct SessionManager imports from both stream host files.
- Reused the existing eighty-eighth Node 22 manager-port candidate; this slice adds no redundant
  bundle candidate.

## Validation

- Focused stream/manager coverage: passed, 9 files / 30 tests.
- Complete Claude adapter coverage: passed, 114 files / 484 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 726 files / 5,016 tests plus 1 skipped.
- `sdk-bridge/index.ts` remains at 499 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the expanded port, stream host factories, aggregate host wiring, processor constructor,
bridge binding, tests, and architecture rules together. Partial injection could release claims or
persist provider identities through a manager different from create-session and recovery.

## Remaining boundary

Pending-cancellation, session-finalization, and usage-snapshot desktop hosts still bind
SessionManager directly. The next slice should inject the smallest lifecycle-compatible subset
without changing close, cancellation, or usage-probe sequencing.
