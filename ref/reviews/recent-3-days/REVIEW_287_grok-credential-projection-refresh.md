---
review_id: 287
reviewed_at: 2026-09-29
baseline_commit: 6b9bed471c3d56f0aa7c9d8e2d5120c997855f22
expired: true
---

# Grok credential projection refresh and headless module boundaries

Final status: installed and accepted at `3bb45616`; issue resolved. See installed acceptance below.

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

## Initial packaging before installed activation

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

Initial package: `build/dist/grok-credential-6b9bed47/Agent Deck-0.1.0-arm64.dmg`.
SHA-256: `540188ffd2e9942b6e75340b7a2343f7bceab3812ba5ce180774cb6ded1f1730`.
The package directory also contained its block map, checksum, and clean build metadata.
At this initial validation point, Desktop and Worker/supervisor activation was still pending.
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
- Installed activation used the new app bundle and official Worker deployment `--upgrade` to
  load the synchronization arguments, with explicit approval for replacing the hosting Desktop.
  Existing live credentials were preserved.
- Installed acceptance completed and the issue is resolved. The completed plan is
  [PLAN_63](../../plans/recent-3-days/PLAN_63_grok-credential-installed-acceptance.md).
- No current source file in this scope needs a size exemption. No Relay Server redeployment is
  required because this fix changes the local Worker/Core and host supervisor.


## Initial local artifact cleanup (2026-09-29)

At the user's request, remove unused reproducible main/preload/renderer, headless, Feishu runtime,
macOS helper outputs and packaging scratch from `build/`: 247 regular files, about 836 MiB.
Directory usage decreased from about 2.3 GiB to 1.5 GiB; `.ref` decreased from 24 KiB to 16 KiB.
No build/test command or open file under
that directory was found before cleanup. The installed application and services were preserved.

Keep the credential-fix package above and move the older root-level installer into
`build/dist/installed-001a044e/` for rollback until replacement acceptance. Its metadata and
`app.asar` match the installed clean `001a044e` application; both retained DMG checksums were verified
after cleanup. The retained directories include build metadata and checksums and stay under the
explicitly packaging-excluded `build/dist/` subtree. `build/dist/README.md` explains their purpose.

Compress the non-final `.ref` plan to current status, invariants, evidence links and next actions;
keep its two Relay probes because installed activation remains pending. No final record or required
acceptance script was deleted. Generated outputs can be recreated through the project build commands.

## Installed acceptance and final cleanup (2026-09-29)

- Installed clean source `3bb45616c0258fbb9b04da2b1c5e6a4e82d1dbb6`, including REVIEW_288
  replacement safeguards and REVIEW_289 UI/documentation fixes. The installed build metadata,
  app archive and exact newly opened application process were verified.
- Official Worker check, dry-run, upgrade and verify passed. Supervisor configuration and native/
  deployed credentials are healthy, its service is running and synchronization arguments are loaded.
- Five retry-disabled Relay isolation cycles passed, with zero failures. Grok stayed enabled and
  client retirement preserved the Worker SSH attachment. Relay Server was not redeployed.
- Issue `611fdd74-7a9f-4f61-af96-d85961696739` was updated to `resolved` through the owned MCP tool.
- After acceptance, remove both superseded package directories, 249 generated build files and the
  two temporary probes. Build usage fell from about 2.89 GiB to 676 MiB, reclaiming about 2.23 GiB.
  Retain only the accepted installer and its metadata/checksum under
  `build/dist/installed-3bb45616/`; the active plan is archived in PLAN_63.
