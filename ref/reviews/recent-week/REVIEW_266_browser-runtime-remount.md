---
review_id: 266
reviewed_at: 2026-09-03
baseline_commit: 837ddd1212198f0d4852a7dfcf0bb3f70ae7772e
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final review/changelog records and bucket indexes are mechanical evidence added after implementation."
---

# REVIEW_266_browser-runtime-remount: Review cross-day Browser recovery

## Scope and method

This review traced Browser capability creation, expiration, volatile-path cleanup, provider turn
delivery, portable Server Core projection, and lifecycle revocation across Claude Code, Codex CLI,
and Grok Build. It also checked the refreshed provider and compatible application package graphs,
the Feishu deployment pin, and packaged macOS binaries. The file-level review-expiry script was run
before finalizing this record.

```review-scope
package.json
pnpm-lock.yaml
deploy/linux/feishu/static-check.sh
src/hosts/server-core/browser-runtime.test.ts
src/hosts/server-core/browser-runtime.ts
src/hosts/server-core/provider-claude-stream-host.ts
src/hosts/server-core/provider-codex-host.ts
src/hosts/server-core/provider-grok-host.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.test.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-core.ts
src/main/adapters/claude-code/sdk-bridge/user-message-stream-host.ts
src/main/adapters/codex-cli/sdk-bridge/__tests__/session-retirement.test.ts
src/main/adapters/codex-cli/sdk-bridge/runtime-host-core.ts
src/main/adapters/codex-cli/sdk-bridge/runtime-host.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/adapters/grok-build/__tests__/turn-queue.test.ts
src/main/adapters/grok-build/bridge-runtime-core.ts
src/main/adapters/grok-build/bridge-runtime-host.test.ts
src/main/adapters/grok-build/bridge-runtime-host.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/browser-use/browser-lease-registry-core.test.ts
src/main/browser-use/browser-lease-registry-core.ts
src/main/browser-use/browser-runtime-context-host.test.ts
src/main/browser-use/browser-runtime-context-host.ts
src/main/browser-use/browser-runtime-context.test.ts
src/main/browser-use/browser-runtime-context.ts
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Browser leases had a 24-hour absolute lifetime but were refreshed only when a provider process generation started. A still-live session resumed after an idle day could load the bundled Browser skill while its launcher capability was expired. | Refresh at each actual provider-turn boundary for Claude, Codex, and Grok, before provider input is submitted. |
| LOW | Local command shims live below a volatile temporary root. If the OS removed that tree while the provider process retained its original `PATH`, refreshing only the in-memory lease could not restore the command. Portable Grok providers likewise cannot receive a rotated context file without replacing their process. | Rebuild the exact local directory/shim/context path before rotating the lease, and let the trusted Server Core owner renew the exact portable capability it still tracks. |

## Security and lifecycle checks

- Public Browser argv still cannot select a session, owner, lease, token, endpoint, cwd, or
  provider identity.
- Local renewal rotates the lease and source generation only after recreating owner-only paths;
  symlinked or wrong-owner directories and commands fail closed.
- Portable renewal accepts only the exact host-retained lease and runtime identity. A conflicting
  live identity is rejected, and lifecycle revocation removes both the lease and the host record,
  so a closed session cannot trigger renewal.
- Renewal hosts are best-effort and cannot turn Browser availability into a provider-message
  availability dependency.

## Dependency compatibility checks

- Non-provider updates stay on the application's existing major versions; Monaco remains on
  `0.55.1` because moving a `0.x` minor boundary is not compatibility-preserving by contract.
- TypeScript compilation, all Electron and renderer tests, production bundling, Feishu's dual-arch
  fixed-runtime build, its mirrored static version check, and deployment automation checks passed
  with the new resolutions.
- The macOS package contains the refreshed application graph and still reports Claude Code
  `2.1.260`, Codex CLI `0.153.2`, and Grok Build `1.0.13` from its direct Worker binaries.

## Validation and evidence

- Fake-clock coverage expired a lease beyond 24 hours, removed its entire temporary runtime root,
  and proved the same provider `PATH` becomes executable again with a rotated generation.
- Portable lease coverage proved exact-capability renewal after expiration and rejected a
  conflicting runtime identity.
- Turn-boundary tests cover Claude stream dequeue, Codex serial turn start, and Grok prompt start.
- Focused provider and Browser coverage passed 13 files and 100 tests.
- `pnpm typecheck` passed architecture, Core Node, and both TypeScript configurations.
- `pnpm test` passed 1,017 files and 6,344 tests; 2 files and 3 opt-in tests were skipped.
- Real-Electron Browser boundaries, production and Feishu runtime builds, logging rules, bundled
  runtime checks, macOS packaging, and direct packaged Worker version checks passed.

## Residual risk

- The deterministic clock and filesystem-removal tests replace a literal 24-hour wait. A real
  overnight installed-app observation remains useful platform acceptance, but no untested timing
  branch remains in the renewal decision.
- A single uninterrupted provider turn lasting longer than 24 hours can still outlive its lease;
  normal user-driven resume and queued-turn paths renew before work starts.

## Verdict

PASS. The cross-day capability expiry and volatile-shim loss have direct Local and Server Core
fixes with lifecycle and identity fencing intact. No CRITICAL, HIGH, MEDIUM, or LOW finding remains
open in the reviewed scope.
