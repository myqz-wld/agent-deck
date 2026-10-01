---
plan_id: 77
status: completed
created_at: 2026-09-30
completed_at: 2026-09-30
base_commit: 22bb5c5c
---

# Unified ask_user MCP

## Goal

Let Claude, Codex, and Grok ask for missing information and choices through one MCP tool whose
questions appear in Pending, so the user does not need to find them in conversation history.

## Constraints And Decisions

- The user requested the feature, clarified Pending integration, and approved the concrete
  three-adapter prompt and MCP contract scope.
- Reuse the existing question UI and answer transport. Keep provider-native permissions and
  plan/diff gates intact. Fall back to available question mechanisms only when MCP is unavailable.
- Submit one to four related questions per call; allow choices, free text, and notes. Preserve
  partial-answer semantics as explicit empty entries, without treating them as consent.
- Block without an application timeout while the call remains live. Cancellation, closure, and
  handoff end the original request; session-id normalization preserves response ownership.
- No database migration, provider SDK change, installation, process restart, or deployment.
- Work ran in the existing checkout. Concurrent unrelated committed work was preserved.

## Completed Tasks

1. Added the shared input/output schema, answer validation, and authenticated Local handler.
2. Implemented the Local pending-question service and connected answer/hydration IPC.
3. Added Core-owned questions using existing Remote pending projection and answer authority.
4. Aligned all three bundled runtime prompts and updated the README.
5. Verified adapter registration, real MCP request/answer/cancellation paths, ownership, input
   validation, hydration, session renaming, handoff cancellation, notifications, and UI state.
6. Completed typecheck, full tests, focused final regressions, build, and artifact checks.

## Validation And Completion

See [CHANGELOG_668](../../changelogs/recent-3-days/CHANGELOG_668_unified-ask-user.md) for commands,
results, and the prompt-asset report. All intended source work is complete; no unresolved design
questions remain. New source behavior has not been activated in the running application.

The next operational step, if requested, is to identify and obtain approval for the exact build
installation/restart target before changing live runtime state.
