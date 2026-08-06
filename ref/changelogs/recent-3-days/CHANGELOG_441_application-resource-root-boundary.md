---
changelog_id: 441
changed_at: 2026-08-05
---

# CHANGELOG_441_application-resource-root-boundary: Share one host resource root

## Summary

Claude, Codex, Grok, and prompt-placeholder resource paths now derive from one Node-compatible
application resource root. Development and packaged layouts remain explicit in the installed host
identity rather than adapter-owned Electron reads.

## Host boundary

- Added one pure development/packaged resource-root resolver beside the immutable application host
  path contract.
- Migrated Claude plugin/baseline/mirror paths, Grok config/convention/profile paths, Codex
  plugin/skills/baseline paths, and prompt resource substitution to the shared resolver.
- Replaced adapter Electron path doubles with application-host doubles where those paths are under
  test; filesystem behavior and app-owned user-data locations remain unchanged.

## Node boundary gate

- Added the shared resource root as a seventh executable Node 22 bundle candidate.
- Added a matching direct-import rule that rejects Electron or desktop logger dependencies.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seven Node 22 bundle
  candidates.
- Focused resource-path ownership coverage: passed, 6 files / 45 tests. The follow-up
  `vi.resetModules` ownership regression suite also passed, 4 files / 28 tests.
- `mise exec -- pnpm build`: passed.
- `mise exec -- pnpm test`: passed, 607 files plus 1 skipped / 4,729 tests plus 1 skipped.
- `git diff --check`, empty cached diff, changed TS/TSX line guard, and global changelog
  id/frontmatter/date-bucket/index validation: passed; 93 changelogs, maximum id 441.

## Do Not Split Protection

Keep the shared resolver, migrated adapter consumers, host-owned tests, and executable bundle proof
together. Leaving one adapter on ambient Electron paths would reintroduce topology-specific resource
identity and make headless behavior dependent on launch environment.

## Remaining boundary

The resource I/O modules still carry desktop settings/diagnostics dependencies that require
separate injected ports before their complete transitive graphs qualify as Core candidates. No
shared development process was touched.
