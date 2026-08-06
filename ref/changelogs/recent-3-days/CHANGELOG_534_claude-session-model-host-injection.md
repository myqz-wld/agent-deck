---
changelog_id: 534
changed_at: 2026-08-05
---

# CHANGELOG_534_claude-session-model-host-injection: Inject Claude model persistence

## Summary

The Claude bridge no longer constructs the desktop session-model controller facade. It now
constructs the provider-neutral controller Core with a required host supplied by adapter
initialization, leaving repository, event-bus, clock, and diagnostic ownership at the desktop
composition boundary.

## Explicit model-option ownership

- Added the existing `SessionModelControllerHost` to the required Claude bridge options.
- Threaded that exact host through the adapter-init Core and its unique desktop implementation.
- Constructed `SessionModelControllerCore` directly inside the bridge.
- Reused `desktopSessionModelControllerHost`; no duplicate repository/event-bus implementation was
  introduced.
- Expanded the bridge architecture rule to reject both the desktop controller facade and its
  concrete host.

## Preserved switch and rollback semantics

- Recovery and provider changes still share the same per-session operation barrier.
- Requested options are still validated before persistence, then published before live apply.
- Provider/model/thinking persistence rolls back together after a live failure.
- A failed live apply still attempts the previous live selection, publishes the existing error
  event, and preserves dormant-session behavior.
- The desktop host retains the same repository, `session-upserted`, clock, and scoped logger.

## Direct evidence

- Adapter-init Core coverage proves the exact model host reaches bridge construction.
- Desktop adapter-init coverage proves the host reads the concrete session repository.
- The live Gateway failure regression uses an injected model host and observes both the attempted
  publication and rollback publication while the original values are restored.
- The shared controller Core suite continues to cover ordering, dormant apply, and rollback.

## Validation

- Focused controller/init/live-switch coverage: passed, 4 files / 6 tests.
- Complete Claude adapter coverage: passed, 117 files / 488 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 729 files / 5,020 tests plus 1 skipped.
- `sdk-bridge/index.ts` remains 497 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required option, adapter-init threading, Core construction, exact-host tests, and
architecture prohibitions together. Falling back to the desktop facade would silently restore
repository discovery inside the provider bridge.

## Remaining boundary

The bridge still imports the desktop recovery transcript/cwd probe facade even though its Node-safe
Core and filesystem host already exist. Injecting that exact host through adapter initialization is
the next small runtime-boundary seam.
