# CHANGELOG_298 - Codex hook origin filtering and external process close tracking

## Summary

- App-managed Codex app-server children now force `AGENT_DECK_ORIGIN=sdk` in live SDK bridge, oneshot summary/hand-off pool, and background usage snapshots.
- Codex hooks emitted by those internal children are dropped by the existing SDK-origin ingest guard instead of being claimed as external CLI sessions.
- Codex hook commands now forward the parent process PID for external terminal sessions; Agent Deck tracks that PID and closes the corresponding CLI session when the process exits.
- Codex `Stop` remains a turn-scoped `finished` event, matching current Codex hook semantics instead of pretending it is a session shutdown signal.
- Synchronized `pnpm-lock.yaml` with the latest commit's dependency bumps to Claude Agent SDK `0.3.181` and Codex `0.141.0`.
- Added focused regression tests for SDK-origin filtering, external process close tracking, Codex Stop translation, live bridge env propagation, oneshot env propagation, background usage env propagation, and hook PID forwarding.

## Validation

- `pnpm exec vitest run src/main/adapters/codex-cli/__tests__/hook-translate.test.ts src/main/adapters/codex-cli/__tests__/hook-installer.test.ts src/main/adapters/codex-cli/__tests__/hook-routes.test.ts src/main/adapters/codex-cli/__tests__/background-usage-snapshot.test.ts src/main/adapters/codex-cli/__tests__/codex-instance-pool.test.ts src/main/adapters/codex-cli/__tests__/sdk-bridge.early-err-cleanup.test.ts src/main/session/__tests__/external-process-tracker.test.ts src/main/session/__tests__/manager-ingest.test.ts`
- `pnpm typecheck`
- `pnpm test` (175 files passed, 1961 tests passed)
