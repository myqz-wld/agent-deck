---
changelog_id: 405
changed_at: 2026-07-27
---

# CHANGELOG_405_transparent-usage-refresh-latency: Clear artifacts and bound refreshes

## Summary

macOS transparent windows now clear both Chromium content and native-window artifacts while active.
Provider quota refreshes stop waiting after five seconds for any single provider, retain its last
successful snapshot when available, and still return fresh data from the other providers.

## Changes

### Transparent window compositor

- Call Electron's macOS `BrowserWindow.invalidateShadow()` when transparency or pin visuals change,
  before and after the existing one-pixel compositor resize.
- Continue invalidating the Chromium web contents every 100 ms while pin or transparency requires
  it, and additionally invalidate the native transparent surface only while transparency is active.
- Preserve the opaque pinned-window path without adding recurring native transparent-surface work.

### Provider usage refresh

- Bound every Claude, Codex, and Grok quota read independently to five seconds so one provider can
  no longer hold the whole Data page refresh open.
- Fall back to that provider's last successful snapshot on timeout; when no prior success exists,
  return a provider-specific timeout state while preserving the other providers' results.
- Keep forced-refresh deduplication and monotonic request ordering so a late older read cannot
  replace a newer snapshot.
- Promote a successful provider result that arrives after the UI deadline into the main cache, so
  later Data-page loads can use it without another provider request.

### Regression coverage

- Cover native invalidation during transparent transitions and periodic transparent repainting.
- Cover hung-provider deadlines, partial success, stale fallback, late-success cache promotion, and
  normal-versus-forced refresh ordering.

## Validation

- `pnpm typecheck`
- `pnpm test`: 390 files and 3,286 tests passed; one credentialed live smoke remained skipped.
- Focused compositor and provider-usage suite: 2 files and 14 tests passed.
- `pnpm build`
- `pnpm logger:check`
- `bash scripts/file-level-review-expiry.sh`
- `git diff --check`

## Do Not Split Protection

None. Changed production files remain below 500 lines.

## Notes

The change is in the main process, so an installed application must be rebuilt and restarted before
it takes effect. The currently running installed app was not overwritten because doing so would
terminate the active Agent Deck session.
