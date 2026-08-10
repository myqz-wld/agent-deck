---
changelog_id: 582
changed_at: 2026-08-09
---

# CHANGELOG_582_podman-health-json-argv: Use executable-first Podman health argv

## Summary

Relay and Full Quadlets now encode Podman JSON health commands with the executable as argv zero,
without the Dockerfile-only "CMD" marker that Podman attempted to execute inside the container.

## Changes

- Corrected Relay and Full appliance HealthCmd arrays to begin with their hardened wrapper.
- Updated both production preflight contracts and static checks to reject a reintroduced "CMD"
  marker.
- Documented the Podman health argv distinction in the Relay deployment notes.

## Validation

- bash deploy/linux/relay/static-check.sh
- bash deploy/linux/full/static-check.sh
- pnpm check:linux-headless
- Target Podman 4.9 comparison: ["CMD","/usr/bin/true"] became unhealthy, while
  ["/usr/bin/true"] became healthy.
- git diff --check

Complete target runtime preflight and live Relay Quadlet acceptance remain the deployment gates.
