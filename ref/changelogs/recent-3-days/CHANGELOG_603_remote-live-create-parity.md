---
changelog_id: 603
changed_at: 2026-08-13
---

# CHANGELOG_603_remote-live-create-parity: Align Remote Live and session creation

## Summary

Remote Live now matches Local for context actions and active-turn runtime changes. New Remote
sessions open as soon as their temporary row exists and follow the provider-assigned canonical id,
while the Remote data-source form has enough vertical room for comfortable entry.

## Changes

### Live session interactions

- Enable the Local-shaped right-click menu on Remote Live rows for active and dormant sessions.
  Archive and delete remain Core-authoritative; compatible protocol 2.6 Cores separately
  negotiate dormant-session reactivation.
- Keep Remote model, Claude/Codex permission, and sandbox controls editable during an active turn
  so changes apply to later work, while retaining the Local Grok sandbox turn-boundary restriction.

### Immediate creation continuity

- Return public Remote creation as soon as the temporary session is registered and navigate there
  immediately. Trusted spawn, fork, and handoff paths still wait for a canonical id.
- Follow temporary-to-canonical renames through profile/Core/generation-scoped aliases, preserving
  selected navigation and mutation idempotency in either event/response ordering.

### Remote source form

- Give the Remote data-source manager a stable `85%` height with a bounded maximum, leaving the
  add-connection form roomy and scrollable on shorter windows.

## Validation

- The complete Electron suite passed 959 files / 6,137 tests; 2 files / 3 explicit live or
  environment cases were skipped.
- Node/Web TypeScript, architecture/Core-node boundaries, the production build, diff hygiene, and
  touched production-file size validation passed.

## Do Not Split Protection

No exception is required. Rename continuity is isolated in a focused module, and every changed
production TypeScript file remains below the repository's 500-line limit.
