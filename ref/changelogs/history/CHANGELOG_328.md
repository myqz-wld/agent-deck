# CHANGELOG_328

## Summary

Add `list_session_events`, a read-only Agent Deck MCP tool for inspecting a related session's normalized activity trajectory.

## Changes

- Added `list_session_events` to the public Agent Deck MCP registry, bringing the public tool count to 19.
- The tool returns paged normalized SQLite `events` rows via `eventRepo.listValidForSession`; it does not read Claude or Codex raw transcript/jsonl files, and corrupt payload rows are filtered before MCP pagination.
- Trajectory reads are allowed only for the caller session itself, spawn ancestors/descendants, or sessions sharing an active Agent Deck team.
- External callers are denied even though the tool is read-only, because the visibility check requires a real session identity.
- Extracted the related-session predicate so `list_sessions` and `list_session_events` share the same spawn/team visibility logic.
- Updated README, bundled Claude/Codex runtime instructions, MCP tool count comments/logs, and MCP PlantUML/index records.

## Validation

- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/tools.test.ts` passed: 86 tests.
- `pnpm test src/main/store/__tests__/event-repo-recent-messages.test.ts` passed: 17 tests.
- PlantUML start/end pairing passed for updated diagrams.
- `plantuml -syntax` returned exit 50 with no stdout/stderr on PlantUML 1.2026.5; no rendered artifacts were generated.
- `pnpm typecheck` passed.
- `git diff --check` passed.
- Simple heterogeneous prompt/tool-description review completed:
  - reviewer-codex reported one LOW README wording issue; fixed by splitting per-session callers from third-party external transport availability.
  - reviewer-claude reported three INFO consistency notes; fixed paired bundled bullets, schema caller text, and `list_session_events` annotation hints.
- Simple heterogeneous code review completed:
  - reviewer-codex reported no actionable findings.
  - reviewer-claude reported one LOW corrupt-row pagination edge case; fixed by adding `eventRepo.listValidForSession` and using it for MCP event pagination.

## Do Not Split

No source file over the project guardrail was added or intentionally kept oversized.
