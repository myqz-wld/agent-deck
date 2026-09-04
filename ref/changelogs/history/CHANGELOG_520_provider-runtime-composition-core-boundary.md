---
changelog_id: 520
changed_at: 2026-08-05
---

# CHANGELOG_520_provider-runtime-composition-core-boundary: Share provider startup composition

## Summary

Provider registration, partial-start failure handling, and repository-to-provider session lifecycle
hooks no longer live inside the Electron bootstrap. One host-neutral composition now accepts the
concrete provider set, registry, lifecycle hook ownership, diagnostics, and live rename policy.

## Provider runtime composition

- Added `initializeProviderRuntimeCore` to register the declared providers in stable order and
  initialize them through the injected registry.
- Preserved partial provider startup: one failed provider is reported without preventing other
  providers from initializing.
- Preserved exact session retirement routing through the registered adapter's `closeSession` and
  retained a no-fallback result for missing or non-closeable adapters.
- Moved provider-specific live-session rename policy behind the owning host instead of teaching the
  Core about the Codex bridge implementation.
- Delayed lifecycle-hook publication until registration and provider initialization have completed;
  registration failure remains fail-closed.

## Desktop host and bootstrap

- Added `provider-runtime-host.ts` as the desktop owner of the three concrete provider instances,
  the shared adapter registry, session-manager hooks, bootstrap diagnostics, and Codex live rename.
- Replaced the duplicate provider setup block in `bootstrap-infra.ts` with the Core plus the desktop
  host while preserving the existing event sink, paths, initialization order, and diagnostics.
- Kept provider repository and bridge implementation imports outside the Node candidate.

## Direct evidence and architecture gate

- Added direct tests for registration order, partial-init results, close routing, exact rename
  delegation, missing-adapter behavior, and registration failure before hook publication.
- Added a static boundary rule that rejects desktop host, concrete provider, repository, session,
  event-bus, logger, Electron, and Electron-log ownership from the composition Core.
- Added the complete composition Core as the eighty-fourth independently bundled Node 22 candidate.

## Validation

- Focused provider/bootstrap coverage: passed, 3 files / 6 tests.
- `mise exec -- pnpm typecheck`: passed; all 84 Node 22 bundle candidates passed.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 721 files / 5,005 tests plus 1 skipped.
- `git diff --check`, the empty cached-index gate, and changed-file line checks passed; new files are
  133 lines or fewer and `bootstrap-infra.ts` remains 369 lines.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the Core contract, desktop host, bootstrap call site, direct tests, and both architecture gates
together. Registration order, partial-init isolation, and session close/rename routing are one
composition contract and must not drift independently.

## Remaining boundary

The provider lifecycle composition is now reusable, but a concrete packaged Server Core factory
still needs authoritative repository/session-console ownership before real Linux and provider
acceptance can begin.
