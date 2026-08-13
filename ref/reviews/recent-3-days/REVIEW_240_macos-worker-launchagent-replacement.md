---
review_id: 240
reviewed_at: 2026-08-13
baseline_commit: 931e931e4913ea4beac6741137e978c956ec509c
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and changelog records plus bucket maintenance are mechanical evidence."
---

# REVIEW_240_macos-worker-launchagent-replacement

## Scope and method

This debug review traced a live Relay Worker `--upgrade` exit 5 through the generated plist,
Provider Supervisor process lifetime, `launchctl bootout` and `bootstrap`, rollback behavior, and
the final Worker readiness gate. Neither the simple-review nor deep-review skill was invoked.

```review-scope
scripts/deployment/worker-supervisor.mjs
scripts/deployment/deployment.test.mjs
```

## Findings and fixes landed

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | macOS can return from `launchctl bootout` before the old Provider Supervisor process and socket are gone. Immediate replacement can then fail with bootstrap exit 5 or race readiness against the retiring process. | Capture the registered process id, wait for that exact process to exit, retry bounded transient bootstrap exit-5 results, and treat the target already being registered as success. Apply the same bounded bootstrap behavior to rollback. |

No confirmed finding remains open in scope.

## Validation and evidence

- The original live upgrade repeatedly failed with exit 5 after its configuration, ABI,
  credential, and runtime-preparation gates had passed.
- A delayed manual bootout/bootstrap succeeded, isolating the failure to LaunchAgent replacement
  rather than the migrated configuration or Worker payload.
- Focused deployment validation passed 14 tests, including transient bootstrap retry and waiting
  for the old process before replacement.
- The real `--upgrade` and subsequent `--verify` passed from
  `~/.agent-deck/deploy/aws-relay-on-mac.worker.json`.
- `pnpm check:deployment`, `pnpm typecheck`, `pnpm build`, `git diff --check`, and the complete
  Electron suite passed. The suite completed 960 files / 6,146 tests, with 2 files / 3 explicit
  environment cases skipped.

## Residual risk

- LaunchAgent state transitions remain macOS-owned. If teardown or bootstrap exceeds the bounded
  wait, deployment still fails instead of waiting indefinitely or addressing an unrelated job.

## Verdict

PASS. Live replacement now handles the observed launchd timing window without weakening exact job
identity or bounded failure behavior.
