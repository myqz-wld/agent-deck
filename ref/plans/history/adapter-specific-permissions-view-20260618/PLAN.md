---
plan_id: adapter-specific-permissions-view-20260618
status: complete
created: 2026-06-18
base_commit: a303197
worktree: /Users/wanglidong/Repository/agent-deck
---

# Adapter-Specific Permissions View

## Goal

Make the Session Detail permission tab adapter-aware:

- Claude-family sessions keep the existing four-layer `~/.claude/settings*.json` permissions scan and UI unchanged.
- Codex sessions show Codex-side permission/configuration data instead of Claude settings.
- The Codex view is read-only and must not modify `~/.codex/config.toml` or app settings.

## Non-Goals

- Do not add a full TOML parser.
- Do not expose Codex `approvalPolicy` as configurable; runtime remains fixed to `never`.
- Do not change Claude permission request handling or pending-permission activity rows.

## Design Decisions

- Keep existing Claude IPC (`permission:scan-cwd`, `permission:open-file`) intact to minimize regression risk.
- Add separate Codex IPC so renderer can branch by adapter without widening the existing Claude scan result shape.
- Codex scan reports the app-owned effective knobs Agent Deck controls: sandbox default/session override, fixed approval policy, Agent Deck MCP enablement/timeout, app-managed MCP servers, marker-managed servers in `~/.codex/config.toml`, top-level model, and raw config text.
- Opening Codex config is restricted to the scanner-reported `~/.codex/config.toml` path.

## Checklist

- [x] Add shared Codex permission scan types and IPC/preload facade.
- [x] Implement main-process Codex read-only scanner.
- [x] Render adapter-specific permissions UI in Session Detail.
- [x] Add focused tests for the Codex scanner.
- [x] Add changelog/review records and validate.
- [x] Commit feature separately from the already committed Codex file-change fix.

## Validation

Completed:

- `pnpm exec vitest run src/main/permissions/__tests__/codex-scanner.test.ts`
- `pnpm exec vitest run src/main/permissions/__tests__/codex-scanner.test.ts src/main/codex-config/__tests__/toml-writer.test.ts src/main/codex-config/__tests__/agent-deck-mcp-injector.test.ts`
- `pnpm typecheck`
- `git diff --check`

## Risks

- Codex config TOML parsing remains intentionally shallow; only Agent Deck marker block and top-level model are interpreted.
- UI labels must be clear that Codex uses sandbox and fixed approval policy rather than Claude-style allow/deny rules.

## Next-Session First Action

Feature implementation, validation, and commit prep are complete. No handoff action remains.
