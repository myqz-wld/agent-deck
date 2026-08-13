---
changelog_id: 519
changed_at: 2026-08-05
---

# CHANGELOG_519_session-creation-defaults-host-hardening: Remove hidden provider defaults

## Summary

The session-creation defaults Core no longer reaches through its dependency object to concrete
Codex configuration, Claude Gateway paths, process environment, or the desktop user's home. Those
provider/runtime defaults now enter through one explicit host while parsing precedence stays intact.

## Defaults Core hardening

- Added `SessionCreationDefaultsHost` for user-home, environment-model, Codex config path/provider
  resolution, and Claude Gateway settings-path ownership.
- Removed direct imports of Codex TOML/model-provider implementation and the Claude Gateway facade
  from the Core.
- Removed direct `homedir()` and `process.env.ANTHROPIC_MODEL` reads from the Core.
- Preserved explicit caller overrides for home and config paths, requested-provider validation,
  discovered-provider fail-closed behavior, and native empty-provider delegation.
- Preserved Claude precedence across profile defaults, Gateway env, layered settings, injected
  environment model, and the `sonnet` fallback.
- Preserved the bounded Codex `config/read` deadline and path-free diagnostic categories.

## Desktop host and composition

- Added `session-creation-defaults-host.ts` as the sole owner of desktop home/environment, Codex
  config/provider functions, and Claude Gateway path composition.
- Updated the existing stable resolver to inject that host alongside settings, Codex app-server
  reads, and diagnostics.

## Direct evidence and architecture gate

- Added direct Core tests proving Codex provider identity and Claude home/Gateway/environment
  defaults come only from injected ports.
- Retained the complete defaults facade suite, production-host suite, and outgoing IPC contract.
- Strengthened the existing architecture rule to reject the new host, Claude Gateway facade, and
  all Codex config implementation imports from the Core.

## Validation

- Focused Core/facade/IPC coverage: passed, 4 files / 27 tests.
- `mise exec -- pnpm typecheck`: passed; all eighty-three Node 22 bundle candidates remained green.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 720 files / 5,001 tests plus 1 skipped.
- `git diff --check`, the empty cached-index gate, direct-import/global-state scans, and the changed
  file line guard passed; the Core remains 420 lines.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the Core host contract, desktop host, stable resolver composition, architecture rule, and direct
plus facade tests together. Provider precedence and the bounded Codex read must not change while
desktop defaults move across the port boundary.

## Remaining boundary

Session-creation provider defaults now have explicit ownership. Continue auditing executable Core
candidates for hidden desktop imports before real Linux/SSH/Feishu/provider acceptance.
