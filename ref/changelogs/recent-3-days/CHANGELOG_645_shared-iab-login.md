---
changelog_id: 645
changed_at: 2026-09-20
---

# Share persistent IAB login across sessions

## Summary

Signing in to a website in IAB now makes that login available to other sessions on the same
desktop. The existing user-assisted sign-in interaction stays in place.

## Changes

- Replace per-session in-memory Browser partitions with one desktop-owned persistent partition.
  Local and Remote sessions using that desktop share website cookies and persistent storage.
- Keep tab ownership, tab identifiers, active tabs, capacity limits, and session teardown scoped
  to each Agent Deck session. Closing a session closes its tabs without clearing website data.
- Update README, the matching Claude/Codex/Grok Browser skills, and Remote Browser tool
  descriptions to distinguish shared website state from session-owned tabs.
- Extend the real Electron fixture with synthetic website login checks across sessions and two
  separate Electron processes. Use a temporary profile so validation never accesses real logins.

## Validation

- `pnpm typecheck` passed architecture checks and both TypeScript configurations.
- `pnpm test`: 1,029 files and 6,386 tests passed; 2 files and 3 opt-in tests skipped.
- `pnpm test:browser-electron` passed shared Cookie/localStorage reuse, session teardown,
  persistence across a fresh Electron process, and existing Browser boundary checks.
- All three Browser skills passed the skill validator, remain identical, and have valid local
  Markdown links. README links passed. Prompt inventory hashes were refreshed.
- `git diff --check` passed. The SQLite binding hash remained unchanged.

## Do Not Split Protection

None. Every changed source file remains below 500 lines.

## Behavior Notes

- Signing out or switching website accounts affects other sessions using the shared profile.
- Website expiry and session-only cookie rules still apply. Tab-local sessionStorage is not a
  persistent login mechanism.
- Existing in-memory session data is not migrated. Sign in once in the shared profile after
  updating the app, then subsequent sessions reuse the website state.
- No profile-selection UI, manual-takeover controls, or additional login workflow was introduced.
- The running application and installed bundle were not restarted or replaced. The main-process
  change requires an application update and restart before it affects the running instance.
