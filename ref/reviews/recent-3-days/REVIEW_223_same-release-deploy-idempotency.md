---
review_id: 223
reviewed_at: 2026-08-10
baseline_commit: d61ab50396182d5f07829ed3efd3c47f76c8cf1c
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Plan, review, changelog, and bucket-index maintenance are mechanical records."
---

# REVIEW_223_same-release-deploy-idempotency: Same-release managed deploy recovery

## Scope and method

A live same-release Relay deployment was traced from the deployment entrypoint through the
existing-instance branch, Manager status/start behavior, and Relay runtime preflight. The failed
mutation was followed only by read-only verification and host-state inspection before source work
resumed. Neither the simple-review nor deep-review skill was invoked.

Review scope:

- `scripts/deployment/server.mjs`
- `scripts/deployment/deployment.test.mjs`

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Same-release `--deploy` unconditionally called Manager `start` for an already-active Relay. The Relay singleton preflight correctly rejected its existing `control.sock`, so an otherwise healthy idempotent deployment reported `command_failed`. | Query the exact managed status after reinstalling evidence, skip duplicate start when the unit is already `active`, and start only a non-active instance. |

No confirmed source finding remains open.

## Validation and evidence

- Live `--check` and `--dry-run` passed for `aws-relay-on-mac` at the baseline release.
- The baseline same-release `--deploy` reproduced `start` with `code=command_failed`; immediate
  `--verify` still reported the exact digest-pinned Relay container healthy, and systemd reported
  the exact unit active/running with no restart.
- `pnpm exec vitest run scripts/deployment/deployment.test.mjs` passed 11 tests.
- `pnpm check:deployment` passed.
- `pnpm typecheck` passed, including architecture-boundary checks.
- `pnpm test` passed 862 test files and 5,632 tests, with 2 files and 3 tests skipped.
- `git diff --check` passed.

## Fixes landed

- Added an explicit same-release existing-instance start decision.
- Preserved recovery for inactive instances while avoiding singleton preflight on an active Relay.
- Added regression coverage for active and inactive managed states.

## Residual risk

- An active but unhealthy instance is not force-restarted by same-release `--deploy`; the final
  `--verify` fails closed so recovery remains an explicit operator decision instead of an implicit
  disruption.
- The corrected release still requires the standard live `--check`, `--dry-run`, `--deploy`, and
  `--verify` acceptance sequence.

## Follow-ups

None.

## Final verdict

PASS for source validation. Live release acceptance remains the deployment gate.
