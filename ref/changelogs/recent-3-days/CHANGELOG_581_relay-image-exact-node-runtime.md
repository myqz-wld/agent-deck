---
changelog_id: 581
changed_at: 2026-08-09
---

# CHANGELOG_581_relay-image-exact-node-runtime: Provision the exact Relay Node runtime

## Summary

Relay images now materialize and verify the exact regular `/usr/bin/node` required by the hardened
entrypoint, and runtime preflight executes that path instead of resolving `node` through `PATH`.

## Changes

- When a runtime base provides only a regular `/usr/local/bin/node`, the Containerfile creates a
  non-symlink hard link at `/usr/bin/node`; the build rejects a missing, symlinked, or non-root-owned
  final executable.
- Both runtime identity and health-scheduler probes now execute `/usr/bin/node` exactly.
- Extended the Relay manifest, deployment notes, and static checks to keep image provisioning and
  runtime preflight aligned with the wrapper contract.

## Validation

- `bash deploy/linux/relay/static-check.sh`
- `pnpm check:linux-headless`
- `pnpm verify:linux-headless`
- `git diff --check`

Target-host ARM64 image build, wrapper execution, complete runtime preflight, and live Quadlet
acceptance remain gated until this source fix is committed.
