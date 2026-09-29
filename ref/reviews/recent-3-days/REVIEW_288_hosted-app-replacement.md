---
review_id: 288
reviewed_at: 2026-09-29
baseline_commit: 697f63b9
expired: true
---

# Hosted application replacement preparation

## Scope and authorization

The user explicitly authorized rebuilding, closing, replacing and reopening
`/Applications/Agent Deck.app` in one operation. Existing authorization covers the exact managed
Relay Worker and Provider supervisor recovery. The session interruption warning was given.
This record documents lead inspection and regressions, not independent paired review.
The review-expiry inventory was read before inspecting the complete changed scope.

```review-scope
README.md
deploy/linux/relay/README.snippet.md
scripts/deployment/common.mjs
scripts/deployment/worker-stop.test.mjs
scripts/deployment/worker-supervisor.mjs
scripts/deployment/worker.mjs
scripts/install-local-macos.mjs
scripts/install-local-macos.test.mjs
```

## Findings and fixes

- MEDIUM: Local installation removed all of `build/dist`, including intentionally retained rollback
  installers. Limit cleanup to the selected generated application; retain other installer artifacts.
- MEDIUM: The configured Worker and Provider supervisor are KeepAlive jobs. Process-only shutdown
  would allow new identities to respawn during app replacement. Add official Worker deployment
  `--stop`: bind the exact Worker id and loaded supervisor executable/config/socket identity, unload
  the configured jobs, and preserve credentials/configuration. Unknown launchctl failures fail closed.
- Add `install:local:mac --prebuilt` for the prepared install phase. It requires current clean Git
  source and matching clean build metadata, repeats the packaged Worker sandbox check, and retains
  the existing staged signing, exact process shutdown, installed validation and rollback behavior.
  `--prebuilt` does not grant `--stop-running` authorization.

## Validation

- Focused installer, process-identity and managed-stop regressions: 25 passed.
- Existing credential-health/deployment regressions also passed.
- `pnpm typecheck` and deployment automation checks passed.
- `pnpm test`: 6,580 passed, 3 existing skips, 1,067 passing test files.
- Read-only inspection confirmed both live jobs have KeepAlive enabled and the supervisor's loaded
  arguments match the exact configured identity. No process mutation was needed for validation.
- All changed scripts remain below 500 lines. No credentials or private deployment identities are
  retained in this record. Application packaging and installed activation follow this source commit.

## Execution and recovery

Use a private, one-shot launchd-owned runner outside the repository to survive host shutdown.
Run official Worker `--stop`, the prepared local installer with `--stop-running --prebuilt`, reopen
this exact application, then run Worker `--check`, `--dry-run`, `--upgrade`, and `--verify` plus the
retained retry-disabled Relay probe. Keep durable sanitized status and private raw output for
recovery. On failure, reopen the existing/rolled-back app; do not claim installed acceptance until
build identity, process identity and health checks succeed. No Relay Server deployment is required.

The active continuation plan remains `.ref/plans/grok-credential-projection-refresh.md` until live
acceptance is recorded and issue `611fdd74-7a9f-4f61-af96-d85961696739` can be resolved.
