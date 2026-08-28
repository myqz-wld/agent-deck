---
changelog_id: 397
changed_at: 2026-07-26
---

# CHANGELOG_397_agent-plugin-recovery-state: Preserve Agent and Plugin recovery state

## Summary

Claude and Grok sessions now retain their selected Agent identity and native Plugin root when Agent
Deck rebuilds a provider runtime. Disconnect recovery, application restart, Claude permission or
sandbox restart, fresh-history fallback, trusted continuation, and native resume no longer silently
fall back to an unnamed Agent or an unmounted Plugin.

## Changes

### Durable session state

- Add nullable Agent name, discovery source, and Plugin-root columns to the session schema.
- Carry those fields through session reads, full-record upserts, both session-rename branches, and
  one atomic profile setter.
- Keep old rows compatible through nullable migration defaults; sessions without a prior selection
  continue to use adapter-native defaults.

### Claude recovery

- Persist `claudeAgentName` and `claudePluginDir` during session finalization.
- Restore them for disconnected-session recovery, missing-jsonl fallback, permission restarts,
  sandbox restarts, and direct native resume.
- Rebuild SDK query `agent` and `plugins` options from the persisted profile.

### Grok recovery

- Persist Grok Agent name, source, and Plugin root as soon as the application session is registered.
- Restore the profile for explicit resume, disconnected runtime recovery, and trusted continuation.
- Rebuild ACP `session/load` metadata and Plugin directories from the restored state.

### Regression coverage

- Add a real Grok recovery-to-ACP-load lifecycle test.
- Add Claude SDK query, disconnect, application-recovery, fresh-history, permission-restart, and
  sandbox-restart assertions.
- Add v047 migration and SQLite round-trip/upsert/rename coverage.

## Validation

- `pnpm typecheck` passed.
- Seven focused lifecycle/schema files passed 65 tests.
- `pnpm test -- --exclude src/main/adapters/grok-build/__tests__/resolve-grok-binary.test.ts`
  passed 368 files and 3,099 tests, with one credentialed smoke skipped.
- The unfiltered suite passed 3,100 tests; its only failure is the pre-existing local-install
  absence of optional package `@xai-official/grok-darwin-arm64`.
- `pnpm build` passed.
- `git diff --check` passed.

## Do Not Split Protection

The migration, repository propagation, and two adapter recovery changes form one state contract and
must land together. Every changed production TypeScript file remains below 500 lines.

## Notes

This is a behavior-correction release with no UI or copy change, so README updates are unnecessary.
The associated debug record is `REVIEW_176_agent-plugin-recovery-state.md`.
