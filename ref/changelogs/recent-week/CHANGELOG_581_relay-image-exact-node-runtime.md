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
- Target ARM64 image `sha256:33138e8ab0549f1df7801a834869f148a8d5275b0c56b239ccd9bbb06a680be2`
  exposed root-owned mode-0755 regular `/usr/bin/node`, executed the Relay wrapper, and retained the
  verified wrapper/bundle hashes.
- Complete runtime preflight, live cutover, health-gated restart, and Worker reconnection passed.

Target-host image and live runtime acceptance are complete.
