---
changelog_id: 535
changed_at: 2026-08-05
---

# CHANGELOG_535_claude-jsonl-discovery-host-injection: Inject Claude transcript probes

## Summary

The Claude bridge no longer imports the desktop jsonl/cwd discovery facade. Its protected recovery
and restart probes now call the Node-safe discovery Core with one required filesystem host supplied
by adapter initialization.

## Explicit filesystem ownership

- Added `ClaudeJsonlDiscoveryHost` to the required bridge options.
- Threaded the exact host through adapter-init Core and the unique desktop adapter composition.
- Switched transcript existence, transcript mtime, and cwd existence probes to their Core functions.
- Kept path construction, filesystem calls, and Claude home discovery in
  `desktopClaudeJsonlDiscoveryHost`.
- Expanded the bridge architecture rule to reject both the discovery facade and desktop host.

## Preserved recovery policy

- Transcript paths still use the existing Claude project-directory encoder and native home.
- Uncertain transcript existence still fails open so the SDK may attempt authoritative resume.
- Uncertain cwd existence still fails open so the SDK performs final path validation.
- Missing or unreadable transcript mtime still returns `null` and cannot satisfy freshness.
- Restart and disconnect recovery continue to share the same protected bridge probe seams.

## Direct evidence

- A bridge-level test injects an observable host and proves transcript path, existence, mtime, and
  cwd probes use that exact object and arguments.
- Existing Core tests retain fail-open/freshness behavior coverage.
- Desktop-host coverage retains the concrete home/path/fs binding.
- Adapter-init tests prove the exact discovery host reaches bridge construction.

## Validation

- Focused Core/host/bridge/init coverage: passed, 5 files / 9 tests.
- Complete Claude adapter coverage: passed, 118 files / 489 tests.
- Node and web TypeScript, architecture, and 88 Node candidate gates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 730 files / 5,021 tests plus 1 skipped.
- `sdk-bridge/index.ts` remains 497 lines; the cached Git index remains empty.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the required bridge option, adapter-init threading, Core calls, injection regression, and
architecture prohibitions together. Restoring a facade call would rediscover the desktop filesystem
inside the provider bridge and split restart/recovery authority.

## Remaining boundary

The bridge still imports the desktop usage-snapshot facade, which constructs SDK/binary/path/clock
dependencies internally. Its existing usage Core and host can be injected through the same adapter
initialization boundary next.
