---
changelog_id: 604
changed_at: 2026-08-13
---

# CHANGELOG_604_deployment-config-home: Standardize the deployment config home

## Summary

User-level Relay and Full deployment material now uses `~/.agent-deck/deploy/` as the documented
home instead of a separate `.config` directory. macOS Worker upgrades also tolerate the bounded
LaunchAgent teardown delay observed while migrating a live installation.

## Changes

### Deployment layout

- Document `~/.agent-deck/deploy/` as the user-level home for copied deployment examples, with
  mode `0700` on the directory and mode `0600` on private configuration and credential files.
- Update the Relay Server, Relay Worker, and Full Server examples so their runtime, supervisor,
  and credential references use the same deployment home.

### macOS Worker replacement

- Wait for the previous Provider Supervisor process to exit after `launchctl bootout` before
  bootstrapping its replacement.
- Retry bounded transient `launchctl bootstrap` exit-5 failures and accept an already-registered
  target instead of leaving an otherwise valid Worker upgrade failed.

## Validation

- A live Relay Worker upgrade and final verification passed from the migrated configuration home;
  the Worker and optional Provider Supervisor are running with the new paths.
- Deployment validation and its 14 focused tests passed.
- TypeScript, the production build, diff hygiene, and the complete Electron suite passed. The
  suite completed 960 files / 6,146 tests, with 2 files / 3 explicit environment cases skipped.

## Do Not Split Protection

No exception is required. The changed production deployment script remains below the repository's
500-line limit.

## Related review

See `ref/reviews/recent-3-days/REVIEW_240_macos-worker-launchagent-replacement.md`.
