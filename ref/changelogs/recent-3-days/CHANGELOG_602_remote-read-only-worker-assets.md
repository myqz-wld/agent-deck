---
changelog_id: 602
changed_at: 2026-08-13
---

# CHANGELOG_602_remote-read-only-worker-assets: Make Remote config read-only and sync Worker assets

## Summary

Remote Settings and Assets now follow the Local presentation while keeping Worker-owned values
visibly disabled and read-only. Local Worker configure/start also synchronizes bounded Local
Agents/Skills into its isolated Provider Home, so the Remote asset catalog reflects the Worker
deployment instead of appearing empty.

## Changes

- Synchronize direct and discovered Plugin Agents/Skills from the terminal user's Home when a
  Local Worker is configured or started. Refresh changed files and remove stale projected files
  through an app-owned manifest without copying provider settings, Hooks, MCP definitions,
  credentials, global instructions, or whole Plugin caches.
- Preserve the existing Worker-packaged assets and add the synchronized user snapshot to the
  same bounded Server Core catalog used by Remote.
- Reuse the Local application-convention editor presentation for Remote: the text remains
  selectable but read-only, the controls are muted/disabled, and the top-right expand button opens
  the full-screen reading view.
- Present Worker configuration and Claude/Codex/Grok Hook status with Local-shaped disabled
  controls and clearer Worker-owned copy.
- Remove Remote Hook mutation from Renderer preload/IPC and stop Server Core from advertising
  Hook install/uninstall methods. Worker deployment may still establish its own Hook state; the
  desktop only reads that state.
- Clarify connection, asset, configuration, and ownership copy without falling back to Local data.

## Validation

- Focused Worker projection, Server Core, Main controller, Remote Settings, and Assets suites pass
  6 files / 27 tests.
- Full TypeScript, test, build, Linux headless Worker/deployment checks, diff hygiene, and touched
  production-file size validation passed.

## Do Not Split Protection

The Worker asset projection is isolated in a focused module. All touched production TypeScript
files remain below the repository's 500-line limit.
