---
plan_id: 87
completed_at: 2026-10-14
status: completed
---

# MCP discovery, control and diff focus

## Goal and authorization

The user approved the recommended session-discovery design, repair of the audited defects, concise synchronized agent instructions, and later requested opening files at their changed region. Baseline: cfa43ce9dd64450859f48346d9ff069b2a3006b3. Work used the existing checkout and preserved the preceding audit records plus concurrent edits from other work.

## Decisions and invariants

- Retain `list_sessions`; following the user's final refinement, default to related open metadata and use explicit `scope: all` for unrelated discovery in the current instance/Core Workspace. History remains an explicit filter.
- Keep event reads relation-bound and destructive control separate from discovery. Unrelated live-session closure needs a one-time host Pending approval with exact target/caller revalidation.
- Share pagination and handoff lineage behavior across hosts, while retaining host path/runtime constraints.
- Put tool parameters, effects, timeouts and recovery in descriptions/schemas. Keep runtime Markdown concise and focused on workflow/provider differences.
- Reveal the first computed text diff once per opened model. No explicit-line input exists on this entrypoint; no new line-routing API was introduced.
- Do not stop/restart the host, replace its installed bundle, or publish. The user subsequently authorized a commit scoped to this delivery.

## Completed work

1. Implemented directory defaults/filtering and repaired history pagination beyond 500 rows.
2. Repaired Core handoff visibility and reply-target/anchor continuity.
3. Added one-use shutdown authority and real Pending integration coverage.
4. Unified tool descriptions, removed public legacy Browser tool registration, and compressed paired runtime assets.
5. Added diff first-change positioning and lifecycle tests.
6. Ran typecheck, focused tests, full tests, build, privacy/link/hash and bucket checks. Archived CHANGELOG_676 and REVIEW_322.

## Validation and final handoff

Build and 180 task-focused tests passed for the initial delivery, with documentation checks also passing. The final default-scope refinement passed 130 related tests. At commit time, the exported staged tree passed typecheck and the full suite (7,167 passed, 6 skipped). Earlier shared-workspace failures came from concurrent permission/runtime-preset changes, which remain separate and were preserved. See REVIEW_322 for evidence. No runtime activation was performed.

Implementation is complete. Load the new build only through a separately authorized runtime action. When the concurrent permission work settles, rerun its full-workspace validation. See `ref/reviews/recent-3-days/REVIEW_322_mcp-handoff-and-control.md` for exact scope and evidence.
