---
review_id: 251
reviewed_at: 2026-08-15
baseline_commit: 48c0bca4a9b314d1f043ed9519f4e07ff57215f3
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final review record and index maintenance are mechanical."
---

# REVIEW_251_remote-profile-schema-migration: Remote profile startup migration

## Scope

```review-scope
src/hosts/electron/model.ts
src/main/remote-host/profile-controller-credential-refresh.test.ts
src/main/remote-host/profile-controller.ts
src/main/remote-host/profile-document.ts
src/main/remote-host/profile-store.test.ts
src/main/remote-host/profile-store.ts
src/main/remote-host/service-snapshot.ts
src/renderer/components/AppHeader.tsx
src/renderer/components/RemoteHost/RemoteConnectionCards.tsx
src/renderer/components/RemoteHost/RemoteHostManagerDialog.test.tsx
src/renderer/remote-host/AppHeader.source-mode.test.tsx
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The profile schema advanced from v3 to v4 without a persisted-data migration. `RemoteHostProfileStore.load()` rejected an otherwise valid v3 document before the service could produce its first snapshot, so even a persisted Local source opened with a generic `RemoteHostPublicError`. | Accept exactly v3 as the sole legacy input, normalize it through the current validators, map `server-core` to `full`, write one v4 document, and retain the Standalone profile, Remote profiles, selected Remote id, SSH paths, instance id, and host-key fingerprint. Unknown, older, and malformed schemas remain rejected. |
| MEDIUM | A direct v3-to-v4 shape conversion could silently reuse an old access credential without the v4 connection-scope pin. The old access-credential id is not semantically equivalent to the new connection scope. | Mark migrated Remote profiles as `refresh-required`, force the migrated source to Local, project the credential as unconfigured, and disable both source selection and connection until the user edits the profile and imports a current server-issued credential. A successful replacement clears the marker and restores normal connection behavior. |

## Root cause and production evidence

- The installed app log showed repeated `remote-host:snapshot` failures with public code
  `internal_error` immediately after otherwise successful process, database, MCP, hook-server,
  storage-maintenance, and Browser startup.
- The persisted Electron Store document used schema v3, Local source mode, one Standalone profile,
  and one selected Relay profile. The current parser accepted only schema v4 and therefore failed
  before registry snapshot creation.
- Git history showed that the v4 ownership-policy change removed all previous parser migration
  results while changing both the Full topology name and credential identity semantics.

## Validation and evidence

- Focused profile-store, credential-refresh controller, source-selector, and Remote manager suites
  passed 4 files / 28 tests. They cover the observed v3 Relay shape, `server-core` to `full`, Local
  fallback, preserved selection, disabled stale credentials, and replacement credential recovery.
- `pnpm typecheck` passed architecture, Core/Node, Node TypeScript, and Web TypeScript checks.
- The official Electron suite passed 967 files / 6,124 tests, with 2 files / 3 conditional skips.
- `git diff --check` passed. All changed production files remain below the 500-line guardrail.
- `bash scripts/file-level-review-expiry.sh` was run before the review.
- `pnpm install:local:mac` passed the production build, bundled Grok check, macOS Worker sandbox,
  Linux headless reproducibility, packaged Worker sandbox, ad hoc signing, installation, and
  installed-artifact validation gates.
- Before installed-app acceptance, the original v3 profile document was copied to
  `remote-host-profiles.json.backup-20260815-pre-v4-migration` with mode `0600`.
- The installed app migrated the real profile exactly once to schema v4, stayed in Local mode,
  preserved the Standalone profile, selected Remote profile, instance id, and host-key fingerprint,
  and marked the Remote credential `refresh-required` without inventing a connection scope.
- The installed app remained running after startup. Its new startup log contained no
  `RemoteHostPublicError`, `remote-host:snapshot`, or error entries, and
  `agent-deck --check-installed` passed.

## Fixes landed

- Added a bounded, one-way v3 profile migration and restored explicit migrated-result persistence.
- Preserved useful profile and host-authentication material without inventing a connection scope.
- Added a durable credential-refresh marker, Local fallback, controller admission checks, renderer
  projection, and actionable UI state.
- Added regressions for migration, connection blocking, current credential replacement, source
  selection, and Remote manager behavior.

## Residual risk

- Migrated Remote profiles intentionally cannot connect until a current connection credential is
  re-imported. This is a visible recovery step, not an automatic weakening of v4 owner policy.
- Schema v1, v2, future versions, and malformed v3/v4 documents remain fail-closed.
- Installed acceptance intentionally did not attempt a Remote connection with the legacy
  credential. The recovery gate must remain closed until the user imports a current credential.

## Verdict

PASS. The startup regression and the unsafe naive-migration path are fixed, the package and install
gates passed, and the installed app consumed and migrated the existing profile without repeating the
startup error.
