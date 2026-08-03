---
review_id: 176
reviewed_at: 2026-07-26
baseline_commit: 2efdb6d35243984707f90f19325fb8d5872d075d
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review-record routing and index maintenance are mechanical archive work."
---

# REVIEW_176_agent-plugin-recovery-state: Agent and Plugin recovery-state audit

## Scope and method

Reproduced the two recovery-state gaps reported by the independent
`diff_run:0715ba19-3f68-4ac8-a446-e7155cbc72d7` audit, traced every live recovery and cold-restart
caller, and verified the repaired state from SQLite through the provider-native load request.

```review-scope
src/shared/types/session.ts
src/main/__tests__/_shared/mocks/session-repo.ts
src/main/store/migrations/index.ts
src/main/store/migrations/v047_sessions_agent_runtime_profile.sql
src/main/store/__tests__/v047-migration.test.ts
src/main/store/__tests__/agent-deck-repos/_setup.ts
src/main/store/session-repo/types.ts
src/main/store/session-repo/core-crud.ts
src/main/store/session-repo/rename.ts
src/main/store/session-repo/__tests__/_setup.ts
src/main/store/session-repo/__tests__/agent-runtime-profile.test.ts
src/main/adapters/grok-build/runtime-factory.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/index.ts
src/main/adapters/grok-build/__tests__/runtime-recovery.test.ts
src/main/adapters/claude-code/sdk-bridge/session-finalize.ts
src/main/adapters/claude-code/sdk-bridge/create-session/create-session-impl.ts
src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts
src/main/adapters/claude-code/sdk-bridge/recoverer/_deps.ts
src/main/adapters/claude-code/sdk-bridge/recoverer/recover-and-send-impl.ts
src/main/adapters/claude-code/sdk-bridge/restart-controller-types.ts
src/main/adapters/claude-code/sdk-bridge/restart-controller.ts
src/main/adapters/claude-code/__tests__/sdk-bridge/_setup.ts
src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/createsession-fail-fast.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-jsonl-precheck.test.ts
src/main/adapters/claude-code/sdk-bridge/__tests__/session-finalize.test.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | `recoverGrokRuntime` replaced the selected Agent name, source, and Plugin root with null before `startGrokRuntime` rebuilt ACP `session/load` metadata. Initial fast-return and trusted-continuation paths also lacked a durable profile boundary. | Persist the three fields atomically, restore them in both runtime constructors, retain them for trusted continuation, and verify the resulting ACP load metadata and Plugin lookup. |
| MEDIUM | Claude Agent name and Plugin root existed only in initial SDK create options. Disconnect recovery, missing-jsonl fallback, cold permission/sandbox restart, and native resume rebuilt SDK `agent` and `plugins` from undefined. | Persist both values at finalization, explicitly propagate them through recovery/restart thunks, and add a central resume fallback from `SessionRecord` before SDK query construction. |

## Evidence and validation

- `bash scripts/file-level-review-expiry.sh` completed before this record was written.
- The SQLite v047 test proves old rows migrate with null values and invalid discovery sources are
  rejected.
- The repository test proves setter, record mapping, lifecycle upsert, and both rename branches
  retain or correctly overwrite the profile.
- The Grok lifecycle test executes `recoverGrokRuntime` through `startGrokRuntime` and asserts the
  actual ACP `session/load` request contains the restored Agent and Plugin directories.
- Claude tests assert native SDK query options plus disconnect, fresh-history, permission-restart,
  and sandbox-restart create options.
- `pnpm typecheck` and `pnpm build` passed.
- Seven focused files passed 65 tests.
- The suite excluding the known missing optional native package test passed 368 files and 3,099
  tests, with one credentialed smoke skipped. The unfiltered suite passed 3,100 tests and failed
  only the pre-existing `@xai-official/grok-darwin-arm64` installation check.
- `git diff --check` passed.

## Fixes landed

- Added one adapter-neutral persisted Agent runtime profile to `SessionRecord` and SQLite.
- Restored Grok profile metadata before ACP runtime load and Claude profile options before SDK
  query creation.
- Covered disconnect, app-recovery, permission/sandbox restart, missing-history fallback, trusted
  continuation, and native resume.

## Residual risk and boundaries

Rows created before v047 contain no historical Agent selection to reconstruct and therefore retain
the previous default-Agent behavior until a selection is persisted by a new session lifecycle.
No unresolved in-scope defect remains.

## Follow-ups

No in-scope follow-up is required. The associated behavior record is
`CHANGELOG_397_agent-plugin-recovery-state.md`.
