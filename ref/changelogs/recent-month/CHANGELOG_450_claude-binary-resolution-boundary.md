---
changelog_id: 450
changed_at: 2026-08-05
---

# CHANGELOG_450_claude-binary-resolution-boundary: Extract Claude binary policy

## Summary

Claude executable override normalization, existence probing, bundled fallback selection, and
health-state signaling now run in a pure resolution policy with explicit host ports. The existing
desktop facade retains settings ownership, packaged SDK discovery, and bounded redacted logging.

## Resolution boundary

- Added a settings-free policy that accepts the configured path, filesystem probe, bundled-binary
  resolver, and optional state observer as explicit inputs.
- Preserved trimmed override priority, absent/blank fallback behavior, missing-override recovery
  state, and the exact propagation of filesystem or bundled-discovery failures.
- Contained observer failures inside the policy so diagnostics cannot change provider launch
  behavior.
- Kept the existing desktop facade and its five-minute abnormal-state aggregation, fixed-field
  diagnostics, recovery logging, and safe failure containment.

## Node boundary gate

- Added the Claude binary policy as the sixteenth executable Node 22 bundle candidate.
- Added a direct-import rule that rejects Node builtins, Electron, SDK runtime discovery, desktop
  settings, runtime-host, and utility singleton dependencies in the policy.

## Validation

- `mise exec -- pnpm typecheck`: passed; the architecture gate executed sixteen Node 22 bundle
  candidates.
- Focused policy/facade coverage: passed, 2 files / 22 tests; the new policy accounts for 1 file /
  7 tests and all 15 original diagnostic/fallback tests remain green.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 619 files / 4,769 tests plus 1 skipped.
- Logger check, `git diff --check`, empty cached diff, changed TS/TSX line guard, and global
  changelog validation: passed; 102 structured changelogs, maximum id 450.

## Do Not Split Protection

Keep the pure policy, desktop facade delegation, direct policy/facade tests, and executable boundary
gate together. Override priority, error propagation, and diagnostic containment form one launch
contract.

## Remaining boundary

Additional provider settings/process ownership, Browser, and checkpoint worker transforms remain
extraction blockers. No shared development process was started, restarted, or stopped.
