# CHANGELOG_281

## Team scheduler waits before archiving empty new teams

### Summary

The team lifecycle scheduler no longer archives a newly created empty team immediately. Empty teams now use the same grace window as closed-member teams, preventing `spawn_session` from creating a team, having the scheduler archive it during SDK startup, and then adding members to an already archived team.

### Changes

- `TeamLifecycleScheduler.scan()` now requires `now - team.createdAt >= graceMs` before archiving a team with no active members.
- Existing old empty team cleanup behavior is preserved by testing old ghost teams with `createdAt` outside the grace window.
- Added a regression test for a fresh empty team staying active during the spawn initialization window.

### Validation

- `pnpm exec vitest run src/main/teams/__tests__/team-lifecycle-scheduler.test.ts`
- `pnpm typecheck`
