---
plan_id: 96
completed_at: 2026-10-15
status: completed
---

# Native Tool Search fallback repairs

Created: 2026-10-15
Status: source validated and integrated into main; activation not performed
Base: a7ff9c5acae0a89dbf666fca8252bce77ae05eb0 (main)
Implementation branch: fix/tool-search-fallbacks-20261015 (deleted after merge)
Task: a9ac59a7-b890-450d-95e6-494c99ae8385

## Goal and authorization

Repair the eager-loading paths identified in REVIEW_330 after PLAN_95. The user approved
optimizing the remaining scenarios and chose existing Claude Gateway configuration over a new
UI switch. This continues the approved complex-work-planning workflow and sequential isolation;
no new interview or repeated final-plan approval is required for these accepted repairs.

## Invariants and decisions

- Preserve native defaults, complete MCP contracts, explicit opt-outs, owning-host boundaries,
  and existing sessions. No obsolete Codex search flags or synthesized real-provider capabilities.
- D1 (user, confirmed): fix Codex startup delivery of explicitly configured model catalogs.
  REVIEW_330 verified the installed native startup-only boundary using synthetic inference.
- D2 (user, confirmed): Claude opt-in uses native Gateway JSON env.ENABLE_TOOL_SEARCH. The user
  selected this route and was told it requires a one-time manual change for a compatible Gateway.
  No new application setting/UI or automatic edits to private provider configuration.
- D3 (user/project, constrained): no live app restart/install/deploy, paid model probes, or agents.
  Disposable native children may contact only fake loopback inference/MCP endpoints.
- D4 (user, confirmed): README stays concise. Detailed implementation and evidence live in ref/.
- D5 (engineering): select only model_catalog_json for startup delivery; never promote arbitrary
  thread config, MCP, permission, hook, or plugin settings to process scope. Preserve precedence.
- D6 (scope): focus on eager fallback paths. Grok already uses native deferred discovery in the
  inspected source. Tool-description rewriting and new observed-state UI are separate follow-ups;
  the existing unknown activation result must remain truthful.
- No LLM calls are needed by the implementation. Configuration resolution, argv construction,
  validation, and fixture assembly are deterministic code.

## Evidence and blindspots

Read ref/reviews/recent-3-days/REVIEW_330_tool-search-loading-evidence.md and its fixture folder.
Native Codex 0.162.1: known model initially exposes zero full MCP definitions; unknown alias
exposes 20 (44,807 characters). Catalog in thread config is ineffective; startup catalog restores
deferral. Native Claude SDK 0.3.299: fake third-party base URL exposes 20 definitions (67,837
characters) by default; explicit true exposes zero initially and one after discovery. These are
serialized characters, not token/billing savings or real-Gateway compatibility evidence.

Codex must cover new, resume, native fork, custom Agent precedence, cached clients and process
generations. Startup metadata must be frozen before first initialization and changes must not
restart existing runtimes. Remote processes must use their own paths/configuration, preserving
the trusted workspace permission/MCP process arguments. Invalid catalogs must fail visibly.
Claude must verify settings-file env with sandbox off and derived settings with sandbox enabled,
including true/false/auto/native behavior, precedence, and isolation between Gateways.

## Sequential tasks and acceptance

1. T1 complete: inspect the smallest Codex startup seam and wire selected model_catalog_json through
   per-session app-server startup for Desktop and Server Core. Validate path/string shape, avoid
   shell interpolation, preserve native defaults when absent and config-layer precedence. Tests
   must cover start/resume/fork and remote boundaries, rejected values, and no live replacement.
2. T2 complete: verify Claude native Gateway env end to end using local fake inference. Fix any
   missing startup propagation independently of sandbox mode; preserve explicit disable and
   native default. If already effective, retain meaningful integration regression evidence rather
   than adding redundant production policy. Never assert an untested Gateway is compatible.
3. T3 complete: validate targeted regressions and native request captures; run pnpm typecheck,
   pnpm test, pnpm build without reinstall/rebuild. Hash the Electron SQLite binding before and
   after. Audit changed boundaries locally; no paired review or delegation authorized.
4. T4 complete: keep README changes minimal; archive the final plan, change/review records and
   sanitized reusable evidence, refresh relevant indexes/buckets, inspect paths and links, and
   update the Agent Deck task. Report actual savings evidence and activation requirements.

## Isolation and cold start

Main's unrelated Claude message/activity edits and REVIEW_331 were preserved during integration.
The earlier task-owned REVIEW_330 copies and index row were reconciled with the committed evidence.
Implementation used an Agent Deck detached worktree and then a temporary branch. Only this plan
and REVIEW_330 evidence were copied into isolation. Installed dependencies were reused through a
worktree-local symlink; no installation scripts ran.

Continuation: read CLAUDE.md and REVIEW_332. Implementation and local integration are finished.
Keep unrelated main changes outside this task's commits. Application activation needs separate
exact approval; do not restart the host or run paid model probes.

## Validation state

`pnpm typecheck`, `pnpm test` (1,184 files / 7,443 tests passed, 3 files / 6 tests skipped),
and `pnpm build` passed. Targeted regressions, the independent catalog export, and native fixture
assertions passed. Native argv catalog delivery and both Claude Gateway settings paths are
confirmed on synthetic endpoints. No real token/cache/billing or live activation claim is made.
SQLite SHA-256 stayed 463d208825f4d2660f4ec14181563c4b2ddbfeb779584c9b3251f0d7aafb2c67.
All changed production sources remain within 500 lines. Record routing and links were checked.

Isolation: .agent-deck/worktrees/agent-deck-01a13f5d-364-mv9lxf7z (removed through Agent Deck;
the session returned to main and the merged temporary branch was deleted).

## Implementation checkpoint

T1 now passes the selected owning-host absolute catalog into startup argv, with Agent-over-Gateway
precedence and new/resume/fork coverage. Cached changes reject before token allocation; staged
Gateway changes reject before mutation. Desktop and Server Core preserve their process boundaries.
The installed Codex native argv fixture deferred all 20 definitions initially and loaded only
list_sessions after discovery. Claude settings-file and production-derived sandbox settings both
confirmed true => 0 then 1 definition, false => 20. Explicit auto:5 on this third-party fake endpoint
remained eager (20); no claim that auto forces compatibility. Existing Claude production propagation
was already correct, so no redundant policy was added. Regression coverage and concise README
configuration guidance were added. Full validation passed as recorded above.

## Completion records

- ref/reviews/recent-3-days/REVIEW_330_tool-search-loading-evidence.md (baseline investigation)
- ref/reviews/recent-3-days/REVIEW_332_tool-search-fallback-repairs.md (repair audit)
- ref/changelogs/recent-3-days/CHANGELOG_685_tool-search-fallbacks.md
- ref/reviews/recent-3-days/REVIEW_330_tool-search-loading-evidence/repair-observations.json

No unresolved source work remains in the approved eager-fallback scope. The user subsequently
authorized merging to main, deleting this worktree/branch, and pushing main. Main fast-forwarded
to source commit 357dfa22fec089450dfec4c8b6be622dcaef49f2 after fetching the unchanged remote base.
The leased worktree and temporary branch were removed; unrelated main work and its review-index
row were preserved. Source files match the validated implementation. This record accompanies the
authorized publication; final remote-ref verification is recorded in the Agent Deck task.
No application installation or restart was performed.
