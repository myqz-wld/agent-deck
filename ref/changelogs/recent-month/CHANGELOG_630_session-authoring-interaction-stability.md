---
changelog_id: 630
changed_at: 2026-08-24
---

# CHANGELOG_630_session-authoring-interaction-stability: Stabilize session authoring interactions

## Summary

Session creation no longer renders unresolved project trust as a temporary final diagnosis,
closed History rows can be reactivated from their context menu, and the expanded message editor
now offers the same image picker as the compact composer without overlapping the window drag area.

## Changes

### Project-trust readiness

- Retain the last settled same-adapter trust presentation while its directory or provider is being
  revalidated, and disable its consent control until the new revision is authoritative.
- Give a newly selected adapter no fabricated trust presentation while its defaults are unresolved.
  Fast results still commit directly, while slow reads use the existing shared 150 ms progress
  boundary without flashing the white-tinted unavailable-trust note.
- Apply the same trust-pending behavior to Local and Remote new-session and issue-resolution forms.

### History reactivation

- Add `重新激活` to unarchived closed Local History rows and route it through the existing
  `reactivateSession` lifecycle API before refreshing the list.
- Offer the same action for Remote History when `sessions.reactivate` is negotiated, independently
  of the broader history-write capability while retaining row-state checks on the Remote Core.
- Keep archived rows on the explicit `取消归档`-then-reactivate path.

### Expanded composer

- Pass the authoritative attachment capability, accepted MIME list, and existing attachment queue
  into the expanded editor, so Codex and other image-capable sessions can add files there.
- Mark the full expanded overlay as `no-drag`, allowing its close control to win over the
  underlying macOS title-bar drag and double-click behavior.
- Document History reactivation and image parity in the README highlights.

## Validation

- Focused Renderer suite: 7 files / 66 tests passed.
- `pnpm typecheck`
- `pnpm test`: 1,007 files passed and 2 skipped; 6,314 tests passed and 3 skipped.
- `pnpm build`
- `pnpm logger:check`
- Browser visual fixture: the slow adapter trace removed the transient trust diagnosis and the
  expanded editor showed its image action, a bounded close control, and the `no-drag` overlay.
- `git diff --check`

## Do Not Split Protection

No exception is required. The largest changed production file is `HistoryPanel.tsx` at 448 lines;
all changed production TypeScript files remain below 500 lines.

## Notes

- The production changes are Renderer-only and can use HMR during development.
- The temporary Browser visual fixtures and tab were removed after verification.

## Related review

- `ref/reviews/recent-3-days/REVIEW_264_session-authoring-interaction-stability.md`
