---
review_id: 318
reviewed_at: 2026-10-12
baseline_commit: dad1f36538b44362ad17d8d0f0897912949a8e8e
expired: false
---

# macOS installation with managed background services

## Scope and method

Investigated the repeated local installation failure and duplicate macOS application entries.
This record covers lead source inspection, deterministic regressions, and an isolated native
launchd check. It is not a paired review or an installed activation result.

```review-scope
scripts/install-local-macos.mjs
scripts/install-local-macos.test.mjs
scripts/local-macos-processes.mjs
scripts/local-macos-processes.test.mjs
scripts/local-macos-services.mjs
scripts/local-macos-services.test.mjs
scripts/local-macos-installation.mjs
scripts/local-macos-installation.test.mjs
scripts/deployment/worker-supervisor.mjs
```

The review-expiry inventory was attempted and exited with status 1 during historical mapping.
The complete installer scope was inspected directly, including the expired
[previous hosted replacement review](../recent-month/REVIEW_288_hosted-app-replacement.md).
No prior coverage was used to exempt changed files.

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Process-only shutdown races launchd KeepAlive: signaled Worker processes immediately return with new PIDs, causing the identity guard to cancel installation. The earlier managed-stop helper was not integrated into local installation. | With explicit `--stop-running`, discover only loaded user Worker and Provider supervisor jobs belonging to the exact installed bundle. Verify trusted definitions and loaded paths/arguments, unload consumers before providers, and restore previously loaded jobs in reverse order after installation or rollback. Keep the process identity guard unchanged. |
| MEDIUM | Staging/signing/shutdown failures bypassed cleanup, leaving a hidden staging bundle and an indexed generated application alongside the old installation. | Wrap preparation, promotion, validation, cleanup, and service restoration in one transaction. Clean failed staging, retain the usable old app and prepared source on early failure, and remove the generated application after validated replacement. |
| MEDIUM | Retrying blindly deleted the previous-installation backup, while promotion failures were outside the rollback boundary. | Refuse an unresolved backup, roll back promotion/validation failures, and preserve the recovery copy when rollback or service recovery fails. |

## Validation and evidence

- The failed install log stopped at the process-identity guard, before replacing the installed app.
- Read-only inspection found two running managed KeepAlive services whose definitions and loaded
  commands match the installed bundle. Spotlight returned the installed and generated applications.
- Focused installer, process-identity, service-lifecycle, and transaction regressions: 38 passed.
- `pnpm typecheck` passed, including architecture checks.
- Full Electron test suite: 1,141 passing files and 7,108 passing tests; 3 files / 6 opt-in tests
  skipped. Command-local settings used four workers and a 20-second test timeout.
- A native test-owned launchd KeepAlive job was loaded from an XML plist, discovered, unloaded,
  observed without respawn, restored to a new running PID, and removed. No production service was
  stopped for this check.
- An additional native fixture delayed SIGTERM exit by five seconds. `bootout` returned in 10 ms
  while the job remained registered as `SIGTERMed`; disappearance took about five seconds. The
  corrected pause helper waited 5.1 seconds, restored a new running PID, and tolerated a repeated
  restore. Timeout tests cover both incomplete removal and successful recovery after the initial
  unload deadline.
- Negative cases cover foreign commands, changed definitions, unsafe file ownership/modes,
  inspection failure, partial unload failure, unloaded services, failed restore, failed staging,
  promotion, installed validation, and rollback.
- Node syntax checks and `git diff --check` passed. Changed source files remain below 500 lines.

## Fixes landed

The standard `pnpm install:local:mac --prebuilt --stop-running` entry point now owns managed service
quiescence and restoration. It reuses existing bounded launchd helpers and requires an unchanged,
clean source commit for prebuilt installation. CLI help describes service pause and recovery.

## Installed attempt and asynchronous removal follow-up

The first authorized attempt using `c58694ba` exposed a missing native lifecycle case: `bootout`
acknowledges removal before the process and launchd registration are gone. Immediate inspection
incorrectly treated pending removal as failure, and recovery could mistake that same doomed job for
an already restored service. The application was not replaced or closed; failed staging was cleaned.

The originally loaded Worker was subsequently restored from its unchanged, fingerprint-verified
definition; both original services passed running-state and health/status checks. The follow-up
requires bounded disappearance before app shutdown or re-bootstrap. Pending removal never counts
as successful restoration, and incomplete unload blocks installation. The updated full suite and
delayed native fixture passed before another installation is considered.

## Residual risk and follow-up

The authorized installed-app replacement follows the clean source commit and rebuilt package.
Use an independent runner because application shutdown interrupts hosted sessions; preserve private
status and reopen a signature-verified installed or rolled-back application on failure as well as
success. Verify installed identity, service recovery, and duplicate-copy removal before reporting
completion. Untrusted or changed service identities abort mutation and require investigation.

The user's external Grok executable and override configuration are outside this repair. Existing
service definitions, credentials, other applications, and retained DMG history are preserved.

Final source and execution handoff: [PLAN_84](../../plans/recent-3-days/PLAN_84_provider-installation-recovery.md).
