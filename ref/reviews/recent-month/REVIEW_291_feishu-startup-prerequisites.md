---
review_id: 291
reviewed_at: 2026-09-29
baseline_commit: ad6cb47c52335d6d0c54397152e1d01c2e055800
expired: false
---

# Feishu startup prerequisites

## Scope and method

Targeted live onboarding diagnosis plus source review and regressions. The exact managed Relay
was inspected through its configured trusted SSH connection and official Feishu control commands.
Operational identifiers, credentials and raw diagnostics remain in private local files.

```review-scope
deploy/linux/feishu/preflight.sh
scripts/deployment/feishu-preflight.test.mjs
src/hosts/server-control/feishu-control-service.ts
src/hosts/server-control/feishu-control-service.test.ts
src/hosts/server-control/feishu-provisioning.ts
src/hosts/server-control/feishu-readiness.ts
src/hosts/server-control/feishu-readiness.test.ts
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Feishu returns HTTP 404 to a homepage HEAD request. The service preflight treated that application status as failed HTTPS connectivity and aborted before starting the gateway. | Check bounded HTTPS transport with certificate verification and HTTPS-only protocol selection. Leave authenticated API and WebSocket readiness to the gateway. |
| MEDIUM | A Type=simple unit becomes active before the runtime opens its management socket. Immediate verification could roll back a healthy startup. | Wait up to 20 seconds for ENOENT/ECONNREFUSED startup transients. Identity, permissions, policy and protocol failures remain immediate failures. |

The directory trust helper moved into provisioning without changing ownership, mode, symlink or
realpath requirements, keeping the controller below 500 lines. Connection rollback and runtime
rollback retain their original authority and protected-file transactions.

## Validation and evidence

- Official app authentication, tenant query and bot information requests succeeded. Exactly the
  three approved tenant scopes were observed in the developer console; user scopes remained empty.
- Official server `check` and `dry-run` returned ready and ready-to-connect. The first `connect`
  failed in preflight. Its rollback removed protected connection files and left the Feishu service
  inactive with zero restarts. No pairing or chat acceptance was claimed.
- Read-only probes from the server returned transport exit 0 for both the homepage HEAD (404)
  and unauthenticated bot API GET (400), confirming the erroneous HTTP-status gate.
- Real local HTTPS regressions accept 404 while still rejecting an untrusted certificate and a
  nonresponding endpoint. Readiness regressions cover delayed sockets, bounded failure and immediate
  permission/policy failures. Relay and Full controller tests verify successful delayed startup.
- Final `pnpm test`: 1,072 files and 6,613 tests passed; two files and three tests skipped.
  `pnpm typecheck`, real-Electron Browser acceptance, Linux headless build/reproducibility,
  both Feishu runtime builds, headless packaging checks and deployment static checks passed.
- An initial validation invocation inherited umask 077 and failed existing fixture mode assumptions.
  Re-running the full suite with the normal 022 child-process umask passed; the diagnostic log itself
  remained mode 0600. No unrelated production permission checks were weakened.
- Both runtime archives were inspected: 26 regular files each, normalized owner metadata, and no
  live credentials or personal machine paths. Staged-content checks passed.
- Official verification of the existing Relay still reported healthy after the failed Feishu
  transaction. The release was not applied during this source-validation stage.

## Residual risk and follow-ups

The user approved the exact managed Relay update. The official release lifecycle activated these
host scripts; generation 23 at `b911844d518b` is verified. Feishu connect and verify now pass with
both WebSocket and Core connected, after the additional runtime/bootstrap repairs in REVIEW_295.
The user set the project icon and the developer console saved long-connection event delivery.
Event/card subscriptions, publication, owner pairing and a real provider response remain in the
active plan. The Desktop application was not repackaged or replaced.

The active onboarding plan remains intentionally non-final under `.ref/plans/`; archive it only
after the external acceptance is complete. Review-expiry tooling exited 1, so the complete changed
scope above was reviewed directly without relying on previous coverage.
