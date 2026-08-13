---
changelog_id: 597
changed_at: 2026-08-12
---

# CHANGELOG_597_remote-provider-readiness-and-history-parity: Restore Remote quotas and History parity

## Summary

Remote Codex quota reads now use the Worker-owned Codex app-server account-limit probe, current
Grok OIDC login documents can be projected into the minimal Worker credential schema, and Local
and Remote History use the same session-card visual hierarchy.

## Changes

### Remote provider readiness

- Bind the Server Core Codex quota reader to the Worker-private provider home, packaged Codex
  executable, and private temporary directory instead of returning a hard-coded unavailable result.
- Allow healthy cold provider probes up to twenty seconds while retaining the Desktop request
  deadline as the outer bound.
- Accept exactly one unambiguous, unexpired Grok OIDC account document and copy only its access
  token mode, access token, and expiry into the Worker credential projection. Refresh tokens,
  account identifiers, and profile metadata are excluded.

### History presentation

- Render Local History through the shared session-card frame and header already used by Remote.
- Align runtime metadata, context usage, activity, Workspace summary, source badge, and pinned state.
- Keep archive, unarchive, and delete as explicit Local-only actions in the card menu; Remote
  History remains read-only.

## Validation

- Focused provider/History coverage passed 11 files / 59 tests.
- The complete Electron suite passed 945 files / 6,059 tests, with only the three explicit
  live/environment cases skipped.
- Node/Web TypeScript, architecture/Core-node boundaries, deployment/static checks, Linux
  headless build, production build, diff hygiene, and production file-size gates passed.
- A direct probe using the Worker's independent Codex credential returned an `ok` quota snapshot;
  Remote Grok session creation capability also reported enabled after the bounded credential
  projection.

## Do Not Split Protection

No exception is required. The new Local History card is a focused shared-presentation consumer,
and all changed production TypeScript files remain below 500 lines.

## Related review

See `ref/reviews/recent-3-days/REVIEW_237_remote-provider-readiness-and-history-parity.md`.
