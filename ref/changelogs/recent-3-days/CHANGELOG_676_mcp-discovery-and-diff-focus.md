---
changelog_id: 676
changed_at: 2026-10-14
---

# MCP discovery and diff focus

## Summary

Independent sessions can discover one another through the existing `list_sessions` tool. Metadata discovery is separate from activity-history access and destructive session control. Opening a text change positions the diff at its first changed region.

## Changes

- Following the user's final refinement, `list_sessions` defaults to `scope: related` and `statusFilter: open` (active plus dormant). Explicit `scope: all` also discovers unrelated metadata. Parent, title, directory and adapter filters only narrow the selected scope. External Local callers must explicitly select `all`. Internal rows are excluded; archived metadata requires an explicit history query and `includeArchived: true`.
- Local discovery covers the current instance; Core discovery stays inside its Workspace. `get_session` shares the non-internal metadata domain. Event reads retain ownership/spawn/team authorization.
- A common bounded-page merger prevents historical queries from stopping at the repository's 500-row per-query cap. `total` is documented as page size.
- `shutdown_session` directly manages caller-created descendants across committed handoffs. Other live targets require one host-owned Pending confirmation, expiring after five minutes. The grant is bound to one invocation and exact caller/target identities, consumed once, and revalidated immediately before closing, including the current management edge for direct grants. Cancellation, transport abort, identity change or handoff never redirects approval to another session. Existing operator reason logging is preserved.
- Core now preserves predecessor-child visibility and canonicalizes message targets and historical DM reply endpoints after handoff. See REVIEW_322 for regression evidence.
- Core no longer registers the 14 legacy Browser MCP tools. Browser CLI and its private session backend remain available.
- Common session tool descriptions are shared; Core output paths, presentation timeouts, worktree transitions and handoff terminal behavior are explicit. Runtime Markdown retains workflow and provider differences without duplicating tool parameters/recovery contracts. Claude/Codex/Grok conventions shrink from 162/187/165 to 92/109/91 lines.
- The Monaco diff view reveals its first computed change after layout, once per opened model. Later diff/layout notifications for that model do not reset user scrolling, and navigation does not steal keyboard focus. Added/deleted whole-file views already start at the changed content.

## Validation

- Commit-time `pnpm typecheck` passed on an exported staged tree, including architecture/Core Node-boundary checks.
- Commit-time full `pnpm test` passed on that same tree: 7,167 passed, 6 skipped, across 1,146 passing files and 3 skipped files. The snapshot excludes unrelated concurrent work and shares only the existing dependency installation.
- Task-focused validation: the initial delivery passed 180 tests across 15 files, plus 15 Markdown contract tests. The final default-scope refinement passed 130 tests across six files, covering Local/Core omission and explicit scopes, dormant sessions, parent-filter isolation, external caller guidance, and published MCP contracts.
- `pnpm build` passed before the small default-scope refinement; it was not repeated for this adjustment.
- Earlier shared-workspace validation encountered four `permissionMode` type errors and 62 test failures (7,123 passed, 6 skipped) in concurrent permission/runtime-preset changes. All six scope-focused files passed in that run. Those changes were preserved and excluded from the independently validated commit.
- SQLite binding checksum stayed unchanged. Prompt inventory hashes, local links, paired instructions, privacy and diff whitespace were checked.

## Do Not Split Protection

`src/main/agent-deck-mcp/__tests__/tools.test.ts` remains an existing shared-fixture suite above 500 lines. Authorization/directory regressions have separate small files; default-scope cases extend the existing handler fixtures. Ownership traversal was extracted from its facade. Splitting the old suite's hoisted module mocks and cross-case fixtures would require a broader test-harness refactor unrelated to the new behavior. Revisit when its shared mock graph or provider cases are reorganized. Changed production modules remain under 500 lines.

## Activation and references

No live application was stopped, restarted or replaced. Main-process/MCP and bundled-instruction changes require the corresponding runtime to load the new build. The running installed application was not updated. The user subsequently authorized a commit scoped to this delivery; concurrent permission and Claude input changes remain separate. No publication was requested.

Related records: `ref/reviews/recent-3-days/REVIEW_322_mcp-handoff-and-control.md` and `ref/plans/recent-3-days/PLAN_87_mcp-discovery-and-control.md`.
