---
review_id: 222
reviewed_at: 2026-08-10
baseline_commit: a4b271a6d97a8c3e8839c6a1f70dcdfb735562f4
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Plan, review, changelog, and bucket-index maintenance are mechanical records."
---

# REVIEW_222_linux-deployment-automation: Managed deployment safety and lifecycle review

## Scope and method

This self-review traced config inputs through local process execution, SSH/SCP transport, release
staging, remote host installation, instance-manager plans and mutations, acceptance evidence,
Full secret initialization, Worker configuration, and read-only live verification. Neither the
simple-review nor deep-review skill was invoked.

Review scope:

- `README.md`
- `deploy/examples/*.json`
- `deploy/linux/full/README.snippet.md`
- `deploy/linux/full/agent-deck-full@.container.in`
- `deploy/linux/manager/linux-headless.package.json`
- `deploy/linux/manager/static-check.sh`
- `deploy/linux/relay/README.snippet.md`
- `package.json`
- `resources/bin/agent-deck-instance-manager`
- `scripts/build-linux-headless.mjs`
- `scripts/check-deployment-automation.mjs`
- `scripts/check-linux-headless.mjs`
- `scripts/deploy-*.mjs`
- `scripts/deployment/*`
- `src/hosts/instance-manager/cli-config.ts`
- `src/hosts/instance-manager/entrypoint.test.ts`
- `src/hosts/instance-manager/entrypoint.ts`
- `src/hosts/instance-manager/index.ts`
- `src/hosts/instance-manager/manager.ts`
- `src/hosts/instance-manager/types.ts`
- `src/hosts/linux-runtime/production-wrapper.test.ts`
- `vitest.config.ts`

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The Full template's explanatory `@@...@@` text looked like an unknown render token, so every automated Full render failed closed. | Reworded the comment and added exact placeholder rendering coverage. |
| HIGH | A first Full create produced the named secrets volume but did not initialize the required credential authority before start. | Added an allowlisted, label-verified, mode-0600 secrets initialization step between create and start. |
| HIGH | A credential archive was only chmodded after `tar` created it, leaving a transient umask-dependent exposure and a failed-build cleanup gap. | Precreate every archive exclusively at mode 0600, preserve that mode through tar, clean failures, and test the resulting mode. |
| MEDIUM | Full secret mount inspection could fail because the SSH administrator could not traverse the mode-0700 service home. | Perform canonical mountpoint checks through non-interactive root privileges. |
| MEDIUM | A resumed Full deploy removed optional Provider credentials when their config values were null. | Stop deleting absent optional files; a fresh volume is already empty and resume now preserves previously initialized optional credentials. |
| MEDIUM | Deploy treated every manager `describe` failure as an absent instance, including tamper or transport failures. | Resume only on the structured `not_found` code and propagate every other failure. |
| MEDIUM | `pnpm ... -- ...` supplied a literal leading separator that the initial parser rejected. | Accept one leading separator and cover the package-script invocation form. |
| MEDIUM | Read-only verification incorrectly required the new managed service home and could not inspect the existing legacy Relay. | Restrict the managed-home requirement to mutating actions and keep verify read-only. |
| MEDIUM | Worker `--check` called the lifecycle status wrapper, which could create local service-state directories. | Limit check to ABI and Workspace inspection; reserve status for explicit verify. |
| MEDIUM | Broad `scripts/**/*.test.mjs` collection caused Vitest to ingest an existing Node-native test file and fail the full suite. | Narrow Vitest collection to deployment tests only; the full suite then passed. |

No confirmed source finding remains open.

## Validation and evidence

- `pnpm typecheck`
- `pnpm test` passed 862 test files and 5,626 tests after narrowing test collection.
- The final focused deployment/entrypoint/wrapper run passed 18 tests, including 8 deployment tests.
- `pnpm build`, `pnpm verify:linux-headless`, `pnpm check:deployment`, and `git diff --check` passed.
- Existing Relay read-only verification reported the expected running, healthy digest-pinned
  container; existing macOS Worker read-only verification reported running.
- Tracked-file scans found no live IP, SSH key path, private-key material, or user-specific absolute
  path in the deployment feature.

## Residual risk

- Full has no real-host acceptance in this change. Its external egress network, volume quotas,
  appliance-image provenance, and optional Provider supervisor must be accepted on the target host.
- Egress and quota values are explicit operator assertions bound into evidence, not replacement
  enforcement mechanisms.
- Legacy Relay verification does not migrate it into instance-manager ownership.

## Final verdict

PASS for source, package, and existing Relay/Worker read-only acceptance. Full production
acceptance remains intentionally pending a supplied target host and image.
