---
changelog_id: 555
changed_at: 2026-08-05
---

# CHANGELOG_555_provider-adapter-core-composition-boundary: Publish provider Adapter cores

## Summary

The concrete Claude Code, Codex CLI, and Grok Build `AgentAdapter` classes are now executable
Node 22 boundary candidates. Explicit hosts supply desktop-owned bridge construction, hooks,
provider validation, fork ownership, diagnostics, and summary execution, while the existing index
modules remain small desktop singleton facades.

## Provider Adapter Core boundary

- Moved each concrete provider class into its own `adapter-core.ts` and made its aggregate host a
  required constructor dependency.
- Kept bridge construction behind the existing Claude/Codex/Grok initialization hosts and moved
  hook installer plus route registration into the new aggregate hosts.
- Injected Claude native-fork execution, child-session deletion, and Gateway target validation;
  injected Codex provider resolution; and injected Grok sandbox resolution plus capability-probe
  diagnostics.
- Routed periodic summary execution for all three providers through their hosts instead of direct
  desktop summarizer imports.

## Desktop composition and preserved behavior

- Rebuilt each desktop singleton from its small `index.ts` facade with the matching desktop host.
- Preserved provider identities, create/resume arguments, native-fork behavior, hook routes,
  integration installation, runtime controls, pending responses, usage snapshots, and summary
  selection.
- Updated the Claude native-fork regression to exercise the injected Core host rather than mocking
  the retired desktop facade.
- This slice changes no protocol, IPC contract, renderer behavior, or Local/Remote source semantics.

## Enforced boundary

- Added all three complete provider Adapter classes to the executable Node 22 bundle gate,
  increasing the stable inventory from 95 to 98 candidates.
- Added architecture prohibitions against importing desktop adapter facades, settings/session
  singletons, Browser ownership, logger, hooks, or summarizer implementations from the Core files.
- Added aggregate host-injection tests covering bridge construction, hook registration,
  integration delegation, Codex provider resolution, Grok sandbox/probe diagnostics, and summary
  delegation.

## Validation

- Provider Adapter Core coverage: passed, 4 files / 7 tests.
- Node and web TypeScript plus architecture gates passed with 98 executable candidates.
- `mise exec -- pnpm build`: passed; the main production bundle transformed 795 modules.
- Canonical Electron full suite: passed, 744 files plus 1 skipped / 5044 tests plus 1 skipped.
- `adapter-core.ts` line counts are Claude 408, Codex 420, and Grok 349; the shared host-injection
  regression is 179 lines.
- `git diff --check` passed and the cached Git index remains empty.
- No shared development or Electron process was stopped, restarted, or signalled.

## Do Not Split Protection

Keep the three value-class extractions, aggregate host contracts, desktop singleton facades,
architecture prohibitions, executable Node candidates, and host-injection regressions together.
Dropping any one would either restore hidden desktop ownership or leave the composition boundary
unproved.

## Remaining boundary

The next extraction target is a headless implementation of the three adapter hosts backed by
explicit provider-settings and session-repository ports, followed by concrete composition into the
injected `createServerCoreRuntime` bootstrap. Real Linux/native packaging, SSH/Podman/systemd
acceptance, and live Feishu/provider acceptance remain explicit environment gates.
