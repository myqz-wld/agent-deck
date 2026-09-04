---
changelog_id: 468
changed_at: 2026-08-05
---

# CHANGELOG_468_codex-fork-runtime-host-boundary: Inject Codex fork runtime settings

## Summary

Codex native-fork target resolution no longer reads the desktop settings store or Agent Deck
instructions asset from its Core policy. The SDK bridge now supplies an explicit desktop host,
leaving sandbox, model, reasoning, working-directory, thread-option, and instruction precedence as
an executable Node 22 boundary.

## Explicit fork runtime host

- Added a required target-runtime host carrying the current default sandbox, application developer
  instructions, and optional native model/reasoning readers.
- Kept per-session sandbox, model, reasoning, developer instructions, config layers, and approval
  settings authoritative over host defaults exactly as before.
- Made fork orchestration require a target resolver instead of silently discovering desktop state;
  the production SDK bridge supplies `resolveDesktopCodexForkTargetRuntime`.
- Preserved the zero-prefix/terminal-prefix fork choice, distinct-client ownership, rollback,
  canonical rename, persistence, and first-turn scheduling paths.

## Executable boundary gate

- Added a direct-import rule rejecting the desktop target host, AGENTS asset facade, settings store,
  runtime host, desktop logger, Electron, and electron-log from the target policy.
- Added the Codex fork target runtime as the thirty-third executable Node 22 candidate.
- Added Core precedence regressions and a desktop-host regression proving current sandbox and
  application instructions are supplied at fork time.

## Validation

- Focused target policy, desktop host, fork orchestration, and two-client integration coverage:
  passed, 4 files / 15 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty-three Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 635 files / 4,826 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the host-neutral target policy, required orchestration dependency, desktop host, precedence and
two-client regressions, direct-import rule, and bundle candidate together. Native fork resolution
must not regain implicit settings or application-instruction discovery.

## Remaining boundary

Codex native-fork target settings are now explicit. Other live provider session/create/resume paths
still read desktop settings directly, and Browser registry ownership plus real Linux/SSH/Feishu/
provider acceptance remain outside this deterministic slice.
