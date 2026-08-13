---
changelog_id: 606
changed_at: 2026-08-13
---

# CHANGELOG_606_remote-settings-agent-runtime-sync: Complete Remote settings and Agent runtime parity

## Summary

Remote Settings now shows every Server Core-owned setting available to the shared Relay and Full
contract without becoming editable. Remote Assets now presents the same effective built-in Agent
runtime configuration as Local, and both deployment modes apply that configuration when an Agent
session is started.

## Changes

### Shared Remote configuration

- Extend the shared Relay/Full configuration contract with session lifecycle values, provider
  executable selections, sandbox profiles, collaboration switches, and the complete provider
  injection projection.
- Keep the Local-shaped Settings hierarchy while rendering remote-owned values as disabled fields.
- Use the same Grok sandbox labels as Local, preserve short lifecycle durations without rounding
  them to zero, and show an unknown state while remote values are still unavailable.
- Keep collaboration switches truthful: disabled values now prevent Claude, Codex, and Grok MCP
  attachment while the internal Hook transport remains available.

### Built-in Agent runtime parity

- Include bundled Agent defaults and user overrides in the Remote Assets contract and reconstruct
  the effective runtime metadata used by Local cards.
- Add built-in `agentName` resolution to Server Core spawn, including Claude Gateway, Codex
  provider, model, thinking, and adapter-native Agent instructions/profile data.
- Resolve the Agent before capability discovery so a configured Claude Gateway or non-default
  Codex provider validates against the same selector used for creation.
- Keep explicit spawn-time runtime fields authoritative and wrap long model/provider values within
  narrow asset cards.

### Relay and Full ownership

- Synchronize an allowlisted non-secret desktop settings snapshot into the Local Worker private
  state whenever its provider home is created or refreshed.
- Merge that snapshot only in Relay Local Worker composition; an explicit Worker option wins.
- Keep Full isolated from Local Worker snapshots and source its values exclusively from its own
  Server Core configuration, including bundled Agent overrides.
- Replace affected internal storage terminology with concise user-facing asset locations and
  read-only copy.

## Validation

- Two approved parallel read-only audits covered Settings and Assets across all three adapters,
  Relay and Full ownership, disabled states, terminology, narrow layouts, and Agent spawn paths.
  Their two high, two medium, and two low findings were fixed and covered by regressions.
- Focused validation passed 8 files / 50 tests after the audit fixes, including real
  capability-backed Claude Gateway and Codex provider creation plus Relay/Full MCP-off behavior.
- The complete Electron test suite, TypeScript checks, architecture/Core-node boundaries,
  production build, deployment tests, and diff hygiene passed.

## Do Not Split Protection

No exception is required. Runtime projection, Agent resolution, Remote presentation, and MCP
transport policy remain in separate focused modules, and every touched production TypeScript file
remains below the repository's 500-line limit.
