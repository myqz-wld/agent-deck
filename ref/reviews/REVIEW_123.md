# REVIEW_123 — adapter-specific permissions tab

- Trigger: user request to show the permissions page by adapter type; Claude unchanged and Codex shows Codex-side details.
- Scope: Session Detail permissions tab, renderer/preload/main IPC contract, Codex config scanner, and focused tests.
- Method: source trace plus targeted tests. No adversarial reviewer pair was spawned because the change is a narrow UI/IPC addition and the Codex scanner is covered with explicit temp-file tests.
- Related changelog: [CHANGELOG_286.md](../changelogs/CHANGELOG_286.md).

## Decisions

1. **MED fixed: Codex sessions previously showed Claude settings**
   - Evidence: `SessionDetail` always rendered `PermissionsView cwd={session.cwd}`, and `PermissionsView` always called `scanCwdSettings`, which scans `.claude/settings*.json`.
   - Fix: pass `agentId` and `codexSandbox` from the session and branch `PermissionsView` by adapter.

2. **MED guarded: Codex permission semantics differ from Claude Code permissions**
   - Evidence: Codex SDK sessions use `sandboxMode` and fixed `approvalPolicy='never'`; the Codex adapter has no SDK pending permission concept and should not display Claude allow/deny/ask rules.
   - Fix: add a separate Codex scan result and UI that shows sandbox, fixed approval policy, skipped Git repo check, Agent Deck MCP status, MCP server lists, top-level model, and raw `config.toml`.

3. **LOW guarded: file opening remains path-whitelisted**
   - Evidence: the existing Claude open handler only opens four candidate `.claude/settings*.json` paths to avoid arbitrary renderer `openPath`.
   - Fix: add a separate Codex open handler that only accepts `~/.codex/config.toml`.

## Validation

- `pnpm exec vitest run src/main/permissions/__tests__/codex-scanner.test.ts` passed: 2 tests.
- `pnpm exec vitest run src/main/permissions/__tests__/codex-scanner.test.ts src/main/codex-config/__tests__/toml-writer.test.ts src/main/codex-config/__tests__/agent-deck-mcp-injector.test.ts` passed: 39 tests.
- `pnpm typecheck` passed.
- `git diff --check` passed.

## Residual Risk

- Codex config parsing remains intentionally shallow. The UI reads Agent Deck's marker-managed MCP block and top-level `model`; it does not attempt to parse arbitrary user TOML tables.
