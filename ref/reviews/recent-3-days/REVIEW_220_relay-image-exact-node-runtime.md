---
review_id: 220
reviewed_at: 2026-08-09
baseline_commit: 9be61c32252e2de0f1265f3da8465294b8888ff6
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Review and changelog routing maintenance are mechanical records."
---

# REVIEW_220_relay-image-exact-node-runtime: Exact Node path in the Relay image

## Scope and method

This issue-specific review traced the failed live Quadlet entrypoint through the image base,
Containerfile, hardened Relay wrapper, image manifest, runtime probes, and static checks. This was
an implementation and self-review pass; neither `simple-review` nor `deep-review` was invoked.

```review-scope
deploy/linux/relay/Containerfile
deploy/linux/relay/README.snippet.md
deploy/linux/relay/preflight.sh
deploy/linux/relay/relay-only.manifest.json
deploy/linux/relay/static-check.sh
```

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The Relay wrapper intentionally requires regular `/usr/bin/node`, but the Containerfile accepted a runtime base that supplied Node only at `/usr/local/bin/node`. Runtime probes used `--entrypoint node`, so the image passed preflight and then exited with status 70 during the live cutover. | The Containerfile now materializes and verifies the exact non-symlink path, while both runtime probes execute `/usr/bin/node` directly. |

No confirmed source finding remains open.

## Validation and evidence

- The first live Quadlet attempt failed before serving traffic with `Relay 运行时未正确安装。` and
  status 70; the guarded cutover restored the old healthy Relay.
- Image inspection confirmed the selected official Node base exposed
  `/usr/local/bin/node` but not `/usr/bin/node`.
- Relay static checks pass and assert both the hardened image provisioning block and two exact-path
  runtime probes.
- Linux headless build and package validation remain required before commit; target-host build and
  runtime acceptance remain required after commit.

## Residual risk

- The corrected image has not yet been rebuilt on the target ARM64 host.
- The live Relay has not yet been cut over to the corrected image digest.

## Final verdict

PASS for source readiness, subject to the listed build and live acceptance gates.
