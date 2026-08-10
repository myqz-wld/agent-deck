---
review_id: 219
reviewed_at: 2026-08-09
baseline_commit: e8a71b83bb4e43eaaf088476f232b3e970cec915
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and changelog routing maintenance are mechanical records."
---

# REVIEW_219_relay-health-startup-gate: Relay health-gated systemd activation

## Scope and method

This issue-specific investigation compared the Relay Quadlet contract with the generated user unit
on Ubuntu 24.04 ARM64 and Podman 4.9.3, then traced the image healthcheck, systemd activation, host
packaging, runtime preflight, and instance-manager health poll. This was an implementation and
self-review pass; neither `simple-review` nor `deep-review` was invoked.

```review-scope
deploy/linux/manager/README.snippet.md
deploy/linux/manager/linux-headless.package.json
deploy/linux/relay/README.snippet.md
deploy/linux/relay/agent-deck-relay@.container
deploy/linux/relay/preflight.sh
deploy/linux/relay/relay-only.manifest.json
deploy/linux/relay/static-check.sh
resources/bin/agent-deck-relay-health-gate
scripts/check-linux-headless.mjs
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Ubuntu 24.04's Podman 4.9 accepts `Notify=healthy` but generates `--sdnotify=conmon`, allowing systemd activation before the Relay control-socket healthcheck succeeds. This violates the documented startup contract and creates an unsafe reboot/startup window. | Added a bounded, fixed-command `ExecStartPost` health gate. It is redundant on Podman versions with native healthy sd-notify and supplies the missing activation fence on 4.9. |
| MEDIUM | Runtime preflight resolved `podman` through ambient `PATH`, while generated Quadlets and the package contract use `/usr/bin/podman`. The identity probe could therefore validate a different executable than production starts. | Preflight now verifies root ownership and mode 0755 for `/usr/bin/podman` and invokes that exact path for info, image, and container probes. |

No confirmed source finding remains open.

## Validation and evidence

- A real Podman 4.9.3 generated unit reproduced `--sdnotify=conmon` from `Notify=healthy`; the
  current official Podman contract documents `healthy` as a distinct sd-notify mode.
- Relay static checks pass and reject a replaced `ExecStartPost`, changed health contract, missing
  fixed Podman path, or weakened helper command fence.
- `pnpm typecheck` passed architecture boundaries and both TypeScript projects.
- The full Electron-ABI suite passed 860 files and 5,612 tests; 3 environment-dependent tests were
  skipped.
- `pnpm build`, `pnpm verify:linux-headless`, the Relay static check, the instance-manager static
  check, and `git diff --check` passed.

## Fixes landed

- Added a root-owned host health gate with a 100-second deadline and a strict Relay container-name
  grammar.
- Added `ExecStartPost` to the exact Quadlet and preflight contract.
- Bound runtime probes and health polling to `/usr/bin/podman`.
- Synchronized the Relay manifest, Linux package map, deployment docs, and tamper checks.

## Residual risk

- The live AWS Relay has not yet been cut over. The committed source fix must pass a real healthy
  and unhealthy canary plus the complete runtime preflight before deployment.
- The helper deliberately keeps `HOME` and `XDG_RUNTIME_DIR` from the systemd user manager because
  rootless Podman storage and runtime discovery require them; loader, Node, and shell startup
  injection variables are cleared.
- `scripts/check-linux-headless.mjs` remains over 500 lines as an existing cohesive integration
  verifier. Revisit extraction when another independent Linux packaging family is added.

## Final verdict

PASS for source readiness. Production cutover remains gated on real Podman 4.9 canary and runtime
preflight acceptance.
