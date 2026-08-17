# Recent Month Plans

## Scope

This bucket contains only plans that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `Completed At` or `completed_at` is within the last 3 days, inclusive |
| `recent-week` | `Completed At` or `completed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `Completed At` or `completed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `Completed At` or `completed_at` is older than 30 days, or missing a parseable date |

## Index Table

| Completed At | Plan | Status | Summary | Related Final Record |
|---|---|---|---|---|
| 2026-08-09 | `PLAN_33_relay-quadlet-live-acceptance.md` | completed | Migrate AWS Relay to rootless Podman with an isolated Mac Worker | CHANGELOG_580-582 / REVIEW_219-221 |
| 2026-08-09 | `PLAN_32_remote-local-capability-parity.md` | completed with external acceptance | Complete Local/Remote parity and Workspace-sandbox delivery | CHANGELOG_578 / REVIEW_217 |
| 2026-08-08 | `PLAN_31_handoff-lifecycle-context-v2.md` | completed with documented residuals | Harden handoff context, lifecycle, and rollback boundaries | CHANGELOG_436 / REVIEW_216 |
| 2026-08-06 | `PLAN_31_linux-remote-core-foundation.md` | completed with follow-up | Deliver Remote Core, Relay/Worker, Feishu, and Workspace foundations | CHANGELOG_565 / PLAN_32 |
| 2026-08-03 | `PLAN_30_context-window-observation-unification.md` | completed | Unify observed context capacity across continuations | CHANGELOG_430 / REVIEW_212 |
| 2026-07-31 | `PLAN_29_review-208-defect-remediation.md` | completed | Close all fifteen defects confirmed by REVIEW_208 | CHANGELOG_427 / REVIEW_209 |
| 2026-07-31 | `PLAN_28_compatibility-and-defect-audit.md` | completed | Clean internal compatibility seams and audit functional defects | REVIEW_208 / PLAN_29 |
| 2026-07-31 | `PLAN_27_runtime-integration-repair.md` | completed with documented residuals | Repair reviewed Hook, gateway, and Codex provider integrations | CHANGELOG_425 / REVIEW_206 |
| 2026-07-30 | `PLAN_26_automatic-worktree-cwd-transition.md` | completed | Move session cwd automatically at the acknowledged provider boundary | CHANGELOG_418 / REVIEW_200 |
| 2026-07-30 | `PLAN_25_hook-event-lifecycle-completeness.md` | completed | Complete hook lifecycle capture without version or paging probes | CHANGELOG_415 |
| 2026-07-29 | `PLAN_24_maintenance-timeout-terminal-policy.md` | completed | Adopt safe disable-until-restart maintenance timeout policy | CHANGELOG_412 / REVIEW_188 |
| 2026-07-29 | `PLAN_23_whole-project-quality-refresh.md` | completed with documented residuals | Harden cross-adapter runtime, storage, UI, logging, and packaging | CHANGELOG_411 / REVIEW_187 |
| 2026-07-27 | `PLAN_22_grok-native-sandbox-controls.md` | completed | Control Grok Build's native process sandbox across session paths | CHANGELOG_406 |
| 2026-07-27 | `PLAN_21_browser-p0-p1-hardening.md` | completed | Harden browser readiness, DOM coverage, and screenshot retention | CHANGELOG_403 / REVIEW_182 |
| 2026-07-27 | `PLAN_20_provider-usage-runtime-control-fidelity.md` | completed | Preserve provider usage and adapter-owned runtime controls | CHANGELOG_402 |
| 2026-07-27 | `PLAN_19_cross-adapter-browser-engine.md` | implemented, real-session validation pending | Open and harden the cross-adapter in-app browser | CHANGELOG_400 / CHANGELOG_403 |
| 2026-07-23 | `PLAN_18_runtime-provider-gateway-unification.md` | completed | Unify Claude Gateway and Codex runtime providers | CHANGELOG_387 |
| 2026-07-23 | `PLAN_17_bundled-agent-runtime-overrides.md` | completed | Configure bundled Agent runtimes without editing packaged assets | CHANGELOG_384 / REVIEW_168 |
| 2026-07-23 | `PLAN_16_grok-build-adapter-profiles.md` | completed | Add Grok Build through ACP and typed adapter runtime profiles | CHANGELOG_383 / REVIEW_167 |
| 2026-07-21 | `PLAN_15_plan-review-pending-queue-composer.md` | completed | Isolate review, queue pending input, and expand the composer | CHANGELOG_379 / REVIEW_165 |
