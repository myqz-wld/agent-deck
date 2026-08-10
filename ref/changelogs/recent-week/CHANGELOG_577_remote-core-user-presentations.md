---
changelog_id: 577
changed_at: 2026-08-07
---

# Remote Core User Presentations

## Summary

Restore Remote `present_plan` and `present_diff` as Core-owned blocking gates while reusing the
existing desktop plan and diff presentations.

## Changes

- Added exact, bounded plan/diff presentation contracts and a memory-only Server Core service.
  Presentations belong to one authenticated session, are included in the authoritative
  `pending.list`, and are resolved only through the existing revision-fenced `pending.respond`.
- Registered `present_plan` and `present_diff` in the private Core MCP host. Plan gates remain
  blocking until a user decision; diff gates honor their bounded timeout and return the same
  approved, revise-with-feedback, or timeout result shape used by Local sessions.
- Reused the shared `ExitPlanRow` and `DiffReviewRow` renderer components. Remote responses carry
  the revision captured with the presentation, while Electron main rereads the current Core
  pending list before responding, so refreshed or cross-source presentations fail closed.
- Remote plan deep review is explicitly unavailable instead of falling through to Local review
  orchestration. Restoring the Core-owned companion review flow remains part of active Task 4.

## Validation

- Focused canonical Electron validation passed 11 files / 67 tests across contracts, Core MCP and
  lifecycle, Remote IPC validation, authoritative pending response, and shared renderer rows.
- `pnpm typecheck` and both architecture boundary checks passed.

## Evidence Limits

- This is deterministic Core/main/renderer coverage, not a live Electron interaction or provider
  acceptance run.
- Handoff, hooks, the Remote deep-review companion, and private Grok authentication remain active
  Task 4 work.
- No shared Electron, SSH, Relay, Worker, or VLESS process was restarted, stopped, or killed.
