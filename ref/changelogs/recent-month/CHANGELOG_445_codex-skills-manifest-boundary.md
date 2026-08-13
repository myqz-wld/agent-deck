---
changelog_id: 445
changed_at: 2026-08-05
---

# CHANGELOG_445_codex-skills-manifest-boundary: Extract the Codex skills mirror codec

## Summary

Codex bundled-skill tree inspection, canonical manifest parsing and serialization, content hashing,
and mirror validation now run in an explicit Node-only codec. The existing installer retains
settings, resource substitution, staging, rollback, cleanup, and diagnostic ownership.

## Manifest boundary

- Added a filesystem-ported tree codec that creates deterministic SHA-256 manifests after the
  caller-owned Markdown transformation.
- Preserved manifest self-validation, expected-tree validation, skill discovery, reserved-file
  rejection, and fail-closed path/signature parsing.
- Reused the codec from the existing atomic publication state machine without changing live-mirror
  replacement or rollback behavior.

## Node boundary gate

- Added the complete skills mirror manifest codec as the eleventh executable Node 22 bundle
  candidate.
- Added a direct-import rule that rejects Electron, desktop logger/settings, application-host, and
  placeholder-wrapper dependencies in the codec.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed eleven Node 22 bundle
  candidates.
- Focused skills mirror coverage: passed, 2 files / 16 tests; the new codec accounts for 1 file /
  4 tests.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 614 files / 4,746 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 97 structured changelogs, maximum id 445.

## Do Not Split Protection

Keep the pure codec, installer delegation, direct codec/installer tests, and executable boundary
gate together. The installer publication and rollback state machine remains one desktop-owned unit
until it can move without weakening atomic replacement or reentrant-publisher behavior.

## Remaining boundary

Codex and Claude plugin publication state machines, bundled-asset scans, provider process/settings,
Browser, and checkpoint worker transforms remain extraction blockers. No shared development
process was started, restarted, or stopped.
