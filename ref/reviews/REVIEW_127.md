# REVIEW_127 - Latest commit and Codex external process lifecycle

## Trigger Context

User asked for a solo review of the latest commit and reported two Codex external-session bugs: the real-time list continuously created external Codex sessions, and closing an external Codex session did not close the corresponding Agent Deck session.

## Method

- Reviewed latest commit `84cba1080cc2aa156276be20343f83eabd36f6f0`.
- Traced Codex hook install, hook translation, session ingest/dedup, live SDK bridge, oneshot instance pool, and background quota snapshot paths.
- Kept review solo per user request; no reviewer agents were spawned.

## Findings And Fixes

### MEDIUM-1 fixed: dependency bump left `pnpm-lock.yaml` on old packages

Evidence: the latest commit changed `package.json` to Claude Agent SDK `^0.3.181` and Codex `^0.141.0`, while `pnpm-lock.yaml` still pinned `0.3.178` and `0.140.0`.

Fix: synchronized the lockfile package, importer, and snapshot entries to `@anthropic-ai/claude-agent-sdk@0.3.181` and `@openai/codex@0.141.0`.

### MEDIUM-2 fixed: app-managed Codex hooks were misclassified as external sessions

Evidence: Codex external hooks are installed globally, but Agent Deck-managed Codex app-server children did not force `AGENT_DECK_ORIGIN=sdk`. The existing session manager guard drops SDK-origin hook events, but these internal summary/probe/live children arrived without that origin and were claimed as external CLI sessions.

Fix: live SDK bridge, oneshot Codex instance pool, and background usage snapshots now force `AGENT_DECK_ORIGIN=sdk`. Added ingest and adapter tests to lock the boundary.

### MEDIUM-3 fixed: external Codex process exit was not reflected in Agent Deck

Evidence: Agent Deck only received Codex hook events. Current Codex docs define `Stop` as turn-scoped, not session-scoped, and there is no reliable `SessionEnd` hook in the current release. Therefore terminal process exit needed a separate signal.

Fix: the installed Codex hook command now forwards the parent process PID, hook routes attach it to the event payload, and a session-side tracker marks only `source='cli'` records closed when that PID exits. Codex `Stop` remains `finished`.

## Validation

- Focused Vitest run passed: 8 files / 44 tests.
- `pnpm typecheck` passed.
- `pnpm test` passed: 175 files / 1961 tests.

## Related Changelog

- CHANGELOG_298
