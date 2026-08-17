---
changelog_id: 580
changed_at: 2026-08-09
---

# CHANGELOG_580_relay-health-startup-gate: Gate Relay startup on container health

## Summary

Relay Quadlets now retain a bounded host-side health gate so Ubuntu 24.04's Podman 4.9 cannot mark
the systemd unit started before the private Relay control socket passes its configured healthcheck.

## Changes

### Startup lifecycle

- Added the fixed-command `agent-deck-relay-health-gate` host helper. It accepts only an exact Relay
  container name, polls rootless Podman for at most 100 seconds, succeeds only for `healthy`, and
  fails immediately for `unhealthy` or an unexpected status.
- Added the helper as the Quadlet's `ExecStartPost`. Podman 5+ keeps its native
  `Notify=healthy` behavior; Podman 4.9 receives the equivalent systemd activation fence through
  the bounded host helper.
- Kept `HealthOnFailure=kill`, systemd restart limits, and the instance manager's independent exact
  container-health poll unchanged.

### Packaging and preflight

- Added the helper to the canonical Linux install mapping and Relay/manager installation docs.
- Made the runtime preflight require root-owned mode-0755 regular files at both the helper path and
  `/usr/bin/podman`; all runtime probes now use that exact Podman executable.
- Added a hardened 20-second runtime canary that requires Podman's user-systemd health timer to
  advance a real container from `starting` to `healthy` before production start.
- Extended the Relay manifest and tamper checks so removing, replacing, or weakening the host gate
  or its scheduler acceptance probe fails static validation.

## Validation

- `pnpm typecheck`
- `pnpm test`: 860 files and 5,612 tests passed; 2 files and 3 tests skipped.
- `pnpm build`
- `pnpm verify:linux-headless`
- `bash deploy/linux/relay/static-check.sh`
- `bash deploy/linux/manager/static-check.sh`
- `git diff --check`
- Target Ubuntu 24.04 / Podman 4.9 canaries: `healthy` was accepted and `unhealthy` was rejected
  with exit status 70 after restoring the user-systemd private bus.
- Complete target runtime preflight passed, the live Quadlet reached `running/healthy`, and a
  controlled service restart preserved health while the Mac Worker reconnected automatically.

Target Ubuntu 24.04 ARM64 deployment acceptance is complete.

## Do Not Split Protection

`scripts/check-linux-headless.mjs` is an existing generated-artifact integration verifier over 500
lines; this change adds one install-mapping assertion without adding a new verification family.
Revisit extraction if another independent Linux packaging family is added.
