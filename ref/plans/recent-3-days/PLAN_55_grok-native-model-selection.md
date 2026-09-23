---
plan_id: 55
completed_at: 2026-09-22
status: completed
base_commit: 1690fa03a68a903123e1e78b4f0d2ee04378698b
---

# Grok Native Model Selection

## Goal

Apply explicit model selection, then native user configuration, then the CLI default to remote
Grok without an application-pinned model or duplicate model catalog.

## Context and Constraints

- Retain the container/Core boundary and credential injection at fixed trusted HTTPS egress.
- Preserve the earlier dependency/model-name changes and reviewer-specific model choices.
- Use isolated fake-provider probes; keep diagnostics outside source and distribution inputs.
- Do not mutate the installed Agent Deck app or deployed remote runtimes without approval.

## Task Breakdown and Decisions

1. Probe the pinned CLI with proxy-only routing. Native defaults and explicit choices work;
   IDs absent from the built-in catalog require native upstream model discovery.
2. Remove the fixed broker model profile and local model list. Bind exact method/path pairs,
   adding only `GET /v1/models`; Core uses the CLI OAuth endpoint for its OAuth credential.
3. Parse native `[models]` defaults and pass a sanitized selector through the trusted launch
   contract into `GROK_DEFAULT_MODEL`. Keep custom endpoint profiles outside the container.
4. Align live model mutation with the real `_meta.model.Ok` acknowledgement discovered during
   ACP probes. Keep user selectors separate from canonical runtime IDs; preserve failure,
   timeout, and database rollback behavior without a legacy reply fallback.
5. Update documentation, validate the source and actual package, then archive the result.

## Validation

- Type/architecture checks passed; 6,410 tests passed, with three opt-in tests skipped.
- Real Grok ACP probes through production broker/proxy code verified selection priority,
  native defaults, discovery failure, and live model switch/reset persistence with fake upstreams.
- macOS packaging and Worker sandbox checks passed; actual archive/source-map/native-binary
  privacy checks and DMG verification passed. The SQLite binding stayed unchanged.
- Modified production files remain below 500 lines. Temporary probes and raw output stay private
  and are removed after their bounded evidence is recorded.

## Final Status and Handoff

Completed in the source tree and generated macOS package. No installation, restart, or remote
deployment was performed. Existing unrelated `.ref` workspaces remain untouched.
Installed-app activation and coordinated Core/container rollout remain separate authorized actions.
See [CHANGELOG_648](../../changelogs/recent-3-days/CHANGELOG_648_grok-native-model-selection.md).
