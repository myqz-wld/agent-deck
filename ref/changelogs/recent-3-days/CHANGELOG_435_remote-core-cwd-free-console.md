---
changelog_id: 435
changed_at: 2026-08-04
---

# CHANGELOG_435_remote-core-cwd-free-console: Add cwd-free remote session contracts

## Summary

Agent Deck protocol 2.0 adds a bounded session-console and project-reference contract that works for
both Server Core and Relay without exposing an authoritative Core workspace path. The existing
cwd-bearing desktop methods remain available to full desktop clients but are no longer part of the
fixed Feishu method surface.

## Contracts and Core boundary

- Added exact `session.console.list/get/create` and `project.list/resolve` method definitions with
  dedicated capabilities, bounded page sizes, opaque cursors, exact result shapes, duplicate
  rejection, and path-shaped project-reference rejection.
- Added a host-neutral Core dispatcher around an injected authoritative session/project port. The
  port resolves an opaque `projectRef` beside the authoritative Core in either the Server Core host
  or local Relay Worker; no gateway or Relay metadata layer resolves or stores a cwd.
- Bumped the protocol major from 1 to 2 because removing cwd-bearing methods from the Feishu
  allowlist is intentionally breaking. Old clients and hosts now fail during version negotiation
  before an ordinary request instead of connecting and later falling back to an unsafe surface.

## Feishu session console

- Migrated session listing, selection, runtime-update lookup, and creation to the cwd-free method
  family for both Server Core and Relay.
- Added `/projects [cursor]` and cursor-based `/sessions [cursor]` pagination. Core page limits are
  sent with each request; the Gateway no longer fetches an unbounded session array and slices it
  locally.
- Removed the Gateway-owned Server Core alias-to-cwd authority. `/create` now asks the authoritative
  Core to resolve an alias, then submits only the returned opaque project reference.
- Added exact untrusted-result validation proving that cwd-bearing session/project objects,
  path-shaped refs, alias drift, oversized pages, duplicates, and unknown fields fail before context
  mutation, creation, or outbound delivery.

## Compatibility and remaining gates

- Standalone and SSH desktop clients retain the original full methods during vertical migration.
- This change publishes the shared contract and dispatcher seam; it does not yet provide the full
  production Core runtime, real Feishu SDK/storage adapters, Linux executable composition, or
  renderer wiring.
- Real Ubuntu/EL9, sshd, systemd/Quadlet, Podman, egress/quota, SELinux/AppArmor, Feishu network,
  provider, Browser, and load acceptance remain unclaimed.

## Validation

- Cwd-free contract/Core/protocol/SSH/Electron/daemon/Feishu focused matrix passed: 44 files and
  264 tests.
- Architecture boundaries and both Node and web TypeScript projects passed through
  `mise exec -- pnpm typecheck`.
- The full suite passed: 545 files and 4,393 tests, with one explicit file/test skip.
- `mise exec -- pnpm build` passed, as did the Full appliance preflight and the Relay and instance
  manager static deployment gates.

## Do Not Split Protection

The new capabilities, fixed Feishu allowlist, exact DTO validation, authoritative project
resolution, and Gateway method migration form one path-nondisclosure boundary. Do not enable only
the consumer methods or restore Gateway-owned cwd resolution without revalidating the complete
Server Core and Relay contract.
