---
changelog_id: 571
changed_at: 2026-08-07
---

# Remote Task and Activity Parity

## Summary

Expose session task records and bounded activity events through the authenticated Remote source,
while reusing the Local Session Detail presentations and preventing any Local IPC fallback.

## Changes

- Added exact desktop-only Core contracts for `session.tasks.list` and `session.events.list`.
  Task visibility is limited to the selected session's personal tasks plus active team memberships;
  events are capped by item, JSON depth/node, per-payload, and aggregate response budgets.
- Added a read-only, Electron-free Server Core task repository and a Workspace-aware event
  projection. Event paths are rewritten to `Workspace`, Worker-private roots are redacted,
  outside-Workspace structured paths are hidden, and attachments/binary values are omitted.
- Split Remote detail reads behind one service reader that retains the existing capability,
  profile, Core-generation, source-epoch, deadline, and client-identity fences.
- Extracted shared task and activity record presentations. Local retains its existing pending and
  image behavior; Remote approvals remain read-only in Activity and actionable only through the
  authoritative Remote Pending flow.
- Remote activity never invokes Local upload/image-blob IPC. Image rows show a bounded placeholder
  until the authenticated Remote asset broker is implemented.

## Validation

- The broad canonical Electron-ABI run passed 70 files and 380 tests across contracts, Server Core
  projection/composition, main validation/service boundaries, and shared renderer views.
- `pnpm typecheck` passed both architecture gates and the Node/renderer TypeScript projects.
- `git diff --check` passed; the Git index remains empty and every changed ordinary TS/TSX file is
  below 500 lines.

## Evidence Limits

- This slice closes Session Detail task reads and recent activity replay. Remote task mutations,
  issues, Browser/MCP/worktree/hooks/assets, image payloads, and the Grok credential broker remain
  active Task 4 work.
- No shared development process was stopped or restarted, and no real Linux/Full/Feishu acceptance
  is claimed by this static and Electron-runner closure.
