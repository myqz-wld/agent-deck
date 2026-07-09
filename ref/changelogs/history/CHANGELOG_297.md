# CHANGELOG_297 - Issue branch snapshots and spawn prompt test fix

## Summary

- Issues now record a best-effort git branch snapshot at creation time as `branchName` / `issues.branch_name`; old rows migrate with `NULL`.
- `report_issue` resolves branch from the final issue cwd (`args.cwd > session cwd > null`) and does not fail issue creation when git detection fails.
- Branch snapshot normalization now rejects overlong valid git branch names before they hit the SQLite `branch_name` check; `report_issue` still creates the issue and records `branchName: null`.
- Added direct git branch detection coverage and repo/MCP regression coverage for overlong branches.
- Issues UI now shows the branch snapshot in the list and detail metadata when present.
- Updated `spawn-agent-name-routing.test.ts` to assert the current MCP spawn prompt contract: wire prefix and hand-off context are injected, while the raw prompt is preserved at the end.
- Resolved follow-up issue `5dada7b9-a327-492e-a98c-af9642ed65fb`.
- Simple-review LOW/MEDIUM follow-ups handled: malformed Codex `hooks.json` shapes no longer throw during status/install, and Codex external `PostToolUse` can clear terminal permission waiting state.

## Validation

- `pnpm typecheck`
- Focused review-fix Vitest run
- `pnpm test` (172 files, 1952 tests)
