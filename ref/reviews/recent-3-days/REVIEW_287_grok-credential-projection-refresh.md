---
review_id: 287
reviewed_at: 2026-09-29
baseline_commit: 6b9bed471c3d56f0aa7c9d8e2d5120c997855f22
expired: true
---

# Grok credential projection refresh and headless module boundaries

## Scope and method

Issue `611fdd74-7a9f-4f61-af96-d85961696739`, explicitly brought into scope by the user,
plus the subsequently requested headless 500-line guard cleanup. Lead source inspection and
regression/packaging validation only; no independent paired review was requested or performed.
The review-expiry inventory was read before inspection. The complete implementation scope,
including unreviewed and expired files, was inspected; packaging filters were checked against the
actual application archive.

```review-scope
package.json
deploy/linux/provider-session/README.md
deploy/linux/provider-session/com.agentdeck.provider-supervisor.plist.in
deploy/linux/relay/README.snippet.md
resources/bin/agent-deck-worker
scripts/deployment/config.mjs
scripts/deployment/worker-credential-health.test.mjs
scripts/deployment/worker-credential-scope.test.mjs
scripts/deployment/worker-supervisor.mjs
src/hosts/linux-runtime/production-wrapper.test.ts
src/hosts/local-worker/entrypoint.ts
src/hosts/local-worker/provider-credential.test.ts
src/hosts/local-worker/provider-credential.ts
src/hosts/local-worker/terminal-service.test.ts
src/hosts/local-worker/terminal-service.ts
src/hosts/provider-session/credential-sync.test.ts
src/hosts/provider-session/credential-sync.ts
src/hosts/provider-session/host-credential-sync.test.ts
src/hosts/provider-session/host-entrypoint.ts
src/hosts/server-core/provider-sandbox-policy.ts
src/hosts/server-core/runtime-composition-options.ts
src/hosts/server-core/runtime-composition.ts
src/hosts/server-core/session-create-capabilities.test.ts
src/hosts/server-core/session-create-capabilities.ts
src/hosts/server-core/session-detail-runtime-options.ts
src/hosts/server-core/session-detail-runtime.ts
```

## Findings and fixes

- MEDIUM: Native Grok login renewal did not update the Worker-private inference credential.
  A valid source and healthy supervisor therefore coexisted with an expired deployed copy and
  disabled Remote Grok. Add a managed host supervisor synchronization loop: install at startup,
  check source file identity every 30 seconds, and serialize atomic projection through the trusted
  Worker CLI. Use one exact Worker identity. Stop aborts only the loop's own helper.
- MEDIUM: Worker verification validated the source rather than the actual deployed projection.
  Add a read-only installed-credential command using the strict minimal schema; validate source
  and installed copy independently, and require both persisted and loaded supervisor arguments.
- LOW: Capability descriptions mapped every Grok failure to unavailable isolation. Preserve the
  existing broker/credential readiness distinction across adapter, option, and sandbox reasons.
- LOW: The full headless gate rejected two exactly-500-line modules. At the user's request,
  extract composition options/defaults/diagnostics and session-detail dependency types into adjacent
  modules. Preserve the previous public exports. Runtime files are now 483 and 468 lines; no
  source in the headless guard's roots reaches its 500-line cutoff.

## Boundaries

Source credentials and helper paths must remain canonical trusted files outside Workspace and
shared Provider runtime authority. Project only the access token and expiry through the existing
atomic installer; refresh tokens and account/profile metadata stay on the host. Invalid/missing/
expired sources preserve the last installed copy and retry without exposing child diagnostics.
Unmanaged supervisors without the complete opt-in argument set keep their existing lifecycle.
The new check does not create missing service/state directories. No real model call is necessary.

## Validation

- Initial regressions failed for stale deployed credentials and misleading capability reasons.
- 65 focused tests passed, including real private-file projection, atomic source rotation,
  invalid-source preservation, serial execution/abort, host wiring, source visibility, persisted
  versus loaded service configuration, and recovery capability revision changes.
- Runtime composition and root regressions: 9 passed after the module extraction.
- Final integrated `pnpm typecheck` and both architecture guards passed.
- Final integrated `pnpm test`: 6,546 passed, 3 existing skips, 1,062 passing test files.
- `pnpm build` and the final macOS packaged build passed after the module extraction.
- `pnpm build:linux-headless`, both-architecture `pnpm build:feishu-runtime`, and
  `pnpm check:linux-headless` passed after the extraction. The former guard failure is resolved.
- `pnpm check:deployment`, standalone Worker bundle validation, shell syntax and diff checks passed.
- New built read-only credential command verified the actual installed Worker copy successfully.
- Built headless artifacts and source maps contained no current machine home/worktree identity or
  private deployment identifiers. Staged content and public commit attribution were inspected.

## Packaging and installed activation

Clean source `6b9bed471c3d56f0aa7c9d8e2d5120c997855f22` is packaged with `dirty: false`.
`pnpm dist:mac` and packaged Worker sandbox checks passed. Actual archive inspection found
published dependency maintainer instructions and local agent permission settings; explicit package
filters now exclude those files. The filtered archive has 14,547 entries and no such paths.
Intentional first-party bundled runtime prompt assets remain included.

The uninstalled application was ad-hoc signed, passed deep/strict signature validation and a repeat
packaged Worker sandbox check, then was repackaged as a DMG. The mounted DMG passed checksum and
signature validation, Worker SQLite ABI preflight, and the new read-only deployed-credential check
against the configured Worker. No live service was stopped or reloaded by these checks.

Scanning 281 application files, including binaries and source maps, found no current local home,
worktree, or private deployment identifiers. Both nested Linux runtime archives were inspected
(74 members); ownership is anonymous root and no private identifiers were found.

Retained package: `build/dist/grok-credential-6b9bed47/Agent Deck-0.1.0-arm64.dmg`.
SHA-256: `540188ffd2e9942b6e75340b7a2343f7bceab3812ba5ce180774cb6ded1f1730`.
The package directory also contains its block map, checksum, and clean build metadata.
The installed Desktop bundle and live Worker/supervisor have not been replaced for this fix.
The previously repaired Relay transport remains accepted in [REVIEW_282](REVIEW_282_relay-stream-retirement-isolation.md)
and [PLAN_59](../../plans/recent-3-days/PLAN_59_relay-handshake-investigation.md).

Deployment behavior is documented in `deploy/linux/relay/README.snippet.md` and
`deploy/linux/provider-session/README.md`. The root README addition was dropped before integration
to preserve concurrent unrelated uncommitted documentation changes without stashing them.

## Residual risk and handoff

- Native OAuth renewal remains owned by the host login. This fix follows source changes; it does
  not log in, exchange refresh tokens, or revive an already-expired native credential.
- Source rotation is observed at the next 30-second poll after a prior helper completes; a helper
  has a 30-second command timeout. Unchanged successful sources are not repeatedly rewritten.
- Installed activation requires the new app bundle and official Worker deployment `--upgrade` to
  load the new supervisor arguments. Replacing/stopping the hosting Desktop needs exact approval
  under `CLAUDE.md` Host Runtime Safety. Existing live credentials are preserved.
- Keep the issue in progress until installed activation/acceptance is complete. Retain the active
  `.ref/plans/grok-credential-projection-refresh.md` and the two private Relay probes until then.
- No current source file in this scope needs a size exemption. No Relay Server redeployment is
  required because this fix changes the local Worker/Core and host supervisor.
