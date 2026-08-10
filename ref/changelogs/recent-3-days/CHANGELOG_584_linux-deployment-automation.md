---
changelog_id: 584
changed_at: 2026-08-10
---

# CHANGELOG_584_linux-deployment-automation: Add managed Linux deployment automation

## Summary

Agent Deck now provides config-driven deployment entrypoints for Relay servers, isolated local
Relay Workers, and Full servers. Server lifecycle changes use the packaged Linux instance manager,
immutable image digests, exact Git release identity, pinned SSH host keys, and generation-bound
acceptance evidence.

## Changes

- Added `deploy:relay-server`, `deploy:relay-worker`, and `deploy:full-server` commands with exact
  config validation and explicit check, dry-run, deploy, upgrade, rollback, and verify boundaries.
- Packaged the Linux instance manager as a root-owned host command with a private JSON interface,
  stable JSON output, deployment-state inspection, and bounded localized failures.
- Added shared release staging, rootless remote installation, image pinning, evidence generation,
  Full secrets-volume initialization, and read-only health verification.
- Added example configs and deployment documentation without live hosts, private keys, or
  credential material. Worker examples keep the Workspace outside the Agent Deck repository.
- Added deployment-focused unit and static checks to the Linux headless verification workflow.

## Validation

- `pnpm typecheck`
- `pnpm test` — 862 files / 5,626 tests passed.
- `pnpm build`
- `pnpm verify:linux-headless`
- `pnpm check:deployment`
- Relay server `--verify` against the existing unmanaged deployment — healthy.
- Relay Worker `--verify` against the installed macOS app — running.
- `git diff --check`

## Acceptance boundary

The existing Relay and Worker received read-only verification only; this change did not adopt or
restart the legacy Relay. Full automation is statically and unit tested but was not deployed to a
real Full host because no target appliance image and host were placed in scope. Optional Remote
Grok Provider supervisor provisioning remains a separate lifecycle.

## Do Not Split Protection

All new deployment source files remain below 500 lines. The largest new module is the bounded
server workflow, while transport, config, artifacts, evidence, and Worker behavior remain separate
cohesive modules.
