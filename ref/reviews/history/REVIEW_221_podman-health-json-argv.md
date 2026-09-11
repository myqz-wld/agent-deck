---
review_id: 221
reviewed_at: 2026-08-09
baseline_commit: 74eca2552339896910028783ad42805129b48a1d
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and changelog routing maintenance are mechanical records."
---

# REVIEW_221_podman-health-json-argv: Podman health command argv semantics

## Scope and method

This issue-specific review traced the second guarded cutover failure through the running Relay,
control socket, health timer, Podman 4.9 CLI contract, Relay Quadlet, and the matching Full appliance
template. This was an implementation and self-review pass; neither simple-review nor deep-review
was invoked.

Review scope:

- deploy/linux/full/agent-deck-full@.container.in
- deploy/linux/full/preflight.sh
- deploy/linux/full/static-check.sh
- deploy/linux/relay/README.snippet.md
- deploy/linux/relay/agent-deck-relay@.container
- deploy/linux/relay/preflight.sh
- deploy/linux/relay/static-check.sh

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Both production Quadlets used Dockerfile-style ["CMD", ...] health arrays. Podman treats every array element as process argv, so it tried to execute a binary named CMD; the otherwise healthy Relay created its socket, then reached unhealthy and was killed with status 137. | Removed the marker from both Relay and Full templates, synchronized their preflight contracts, and added static rejection of the invalid form. |

No confirmed source finding remains open.

## Validation and evidence

- The corrected Relay image started, created the expected mode-0600 control socket, and remained
  alive until the configured invalid health command made Podman kill it; guarded rollback restored
  the old healthy service.
- The target Podman 4.9 CLI manual documents JSON health argv as
  ["command", "arg1", ...], not Dockerfile's ["CMD", ...] form.
- A target-host comparison reproduced unhealthy and exit status 70 with the marker, then reached
  healthy with executable-first argv.
- Relay and Full static checks plus Linux headless package checks passed.
- A production-shaped Relay canary reported health exit 0, and the corrected live Quadlet passed
  cutover, restart, Mac Worker reconnection, and client bridge admission.

## Residual risk

- Full appliance was corrected for protocol parity but has not received real-host acceptance in
  this task.

## Final verdict

PASS for Relay source and live acceptance. Full appliance real-host acceptance remains staged.
