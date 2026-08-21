---
changelog_id: 599
changed_at: 2026-08-12
---

# CHANGELOG_599_automatic-remote-provider-catalog: Derive Remote provider choices automatically

## Summary

Remote session creation no longer requires a separately maintained `sessionCatalogFile`. The
trusted Worker startup path derives Gateway, Provider, model, and runtime defaults from the
operator's existing Claude, Codex, and Grok configuration and publishes only a bounded non-secret
snapshot to Server Core.

## Changes

### Automatic provider projection

- Derive Claude Gateway choices and defaults from user-owned Claude settings and Gateway profiles,
  Codex Provider choices and defaults from Codex configuration, and Grok defaults from Grok
  configuration.
- Project only the runtime inputs needed by isolated Worker sessions: sanitized Claude Gateway
  files and the allowlisted Codex model/provider sections. Hooks, MCP definitions, global
  instructions, arbitrary paths, and raw settings files remain excluded.
- Read source files through one bounded descriptor with canonical ownership and change detection,
  then publish private Worker files through verified atomic replacement.
- Refresh the projection on Worker configuration and every explicit Worker start so configuration
  changes require only a Worker restart, not catalog maintenance.

### Public configuration removal

- Remove `sessionCatalogFile`, `--session-catalog`, the hand-maintained catalog example, and the
  corresponding deployment/runtime option.
- Strip the retired catalog field at the private Local Worker and Full config upgrade boundaries so
  existing installations restart cleanly without retaining its behavior.
- Make Server Core consume only the internal derived snapshot and apply provider-specific model and
  reasoning defaults without reading original provider configuration during Remote requests.
- Update Relay and Full deployment documentation and static checks to describe and enforce the new
  trust boundary.

## Validation

- Provider projection, catalog parsing, session capability, Worker lifecycle, and runtime
  composition and legacy-config migration coverage passed 10 files / 55 tests.
- The complete Electron suite passed 958 files / 6,116 tests; 2 files / 3 explicit live or
  environment cases were skipped.
- Deployment contract tests and Relay/Full/deployment static checks passed.
- Node/Web TypeScript, architecture/Core-node boundaries, the production build, shell syntax, diff
  hygiene, and the production file-size gate passed.

## Do Not Split Protection

No exception is required. Filesystem trust primitives, provider projection, and catalog parsing are
split into focused modules, and every changed production TypeScript file remains below 500 lines.
