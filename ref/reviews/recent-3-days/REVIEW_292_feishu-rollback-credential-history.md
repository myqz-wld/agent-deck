---
review_id: 292
reviewed_at: 2026-09-29
baseline_commit: 4240bd919851b14ffc4952bcf14b57cc8bd495e0
expired: false
---

# Feishu rollback credential history

## Scope and method

Live diagnosis of the authorized Relay update, source inspection, and targeted regression tests.
The user approved updating/restarting the existing Relay. Desktop replacement remains deferred.

```review-scope
src/hosts/server-control/feishu-control-service.ts
src/hosts/server-control/feishu-control-service.test.ts
src/hosts/server-control/feishu-authority-repair.ts
src/hosts/server-control/feishu-authority-repair.test.ts
src/hosts/server-control/entrypoint.ts
scripts/deployment/remote-relay-authority.sh
scripts/deployment/server.mjs
scripts/deployment/server-recovery.test.mjs
deploy/linux/feishu/README.md
```

## Findings

- HIGH: Failed Feishu enrollment restored an earlier authority-file snapshot after the live Relay
  could already persist the new credential. The authority watcher then rejected deleted history
  and revoked cached grants. Restart failed because the persisted credential lacked authoritative
  history. Inspection found eight cached rows versus seven authoritative rows, including one orphan
  Feishu revocation. Target and previous Relay container image digests were identical.
- MEDIUM: The deployment upgrade path attempted describe before recovering a retained lifecycle
  journal, preventing the normal manager recovery path after an incomplete cutover.

## Fixes landed

- Rollback revokes the exact attempted credential through the normal connection service instead
  of restoring whole-file snapshots. Its public history remains present, SSH access is revoked,
  and concurrent independent enrollments are preserved. Retry uses a fresh credential id.
- A root-only recovery command restores missing Feishu public history exclusively as revoked
  authority entries. It validates canonical regular files, private mode, service ownership, the
  full metadata schema and exact instance binding. Non-Feishu or foreign-instance inconsistencies
  fail closed. Existing authority grants, authorized_keys and metadata contents are not rewritten.
- The official Relay upgrade path runs this bounded recovery after installing validated host
  artifacts. On recovery_required, it delegates journal recovery to the manager's start command,
  then reads the recovered generation and resumes the upgrade. Other failures and Full are not
  retried through this path. No direct systemctl/Podman lifecycle workaround is used.

## Validation and evidence

- Reproduced strict startup rejection from a persisted orphan, then verified successful reopening
  after recovery: original worker authority becomes active and the failed Feishu id remains revoked.
- Tests cover idempotency, public-key preservation, unchanged metadata/SSH entries, rejected foreign
  or non-Feishu rows, private permissions, owner mismatch and symlinks.
- Both Relay and Full rollback tests preserve revocation history and a concurrent desktop enrollment.
- Deployment tests prove describe/start/describe ordering only for the intended recovery condition
  and stop immediately when recovery fails.
- Typecheck, 6,621 full-suite tests, Linux headless build/reproducibility, headless packaging checks
  and deployment checks passed. Three tests retain their existing skips.
- Source, staged content and generated headless artifacts passed privacy inspection. Changed source
  files remain below 500 lines. Raw runtime evidence and recovery backups are private.

## Residual risk and follow-ups

At this source checkpoint, the previous generation remains recorded and the failed upgrade journal
is preserved for managed recovery. Live activation and Feishu messaging acceptance are still required;
the active plan retains that work. Transport-only Relay health had remained green while credential
admission was unhealthy, so successful socket probing alone must not be treated as business acceptance.
