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
| 2026-08-27 | `PLAN_45_adapter-session-commands.md` | completed | Integrate native adapter slash commands into Agent Deck | CHANGELOG_631 |
| 2026-08-24 | `PLAN_44_pi-adapter-project-trust.md` | completed | Design Pi integration and add native project trust to existing adapters | CHANGELOG_628 / REVIEW_262 |
| 2026-08-18 | `PLAN_43_unified-browser-skill-cli-iab.md` | completed with Remote live gate retained | Unify Browser skill, CLI, responsive IAB, and annotation | CHANGELOG_618 / REVIEW_255 |
| 2026-08-18 | `PLAN_42_summary-settings-layout-and-timeout-policy.md` | completed | Align generator settings order and internalize summary timeout | REVIEW_254 |
| 2026-08-18 | `PLAN_41_current-only-gap-sweep.md` | completed | Close remaining utility, root-config, prompt, and settings-copy gaps | REVIEW_253 |
| 2026-08-17 | `PLAN_40_current-only-compatibility-sweep.md` | completed | Remove unsupported compatibility code by functional boundary | REVIEW_252 |
| 2026-08-17 | `PLAN_39_codex-gateway-toml-cutover.md` | completed | Cut Codex selection over to complete Gateway TOML files | CHANGELOG_616 |
| 2026-08-14 | `PLAN_38_feishu-one-click-server.md` | Relay accepted; Full/real Feishu external pending | Add server-managed Feishu for Relay and Full | CHANGELOG_612 / REVIEW_248 / REVIEW_249 |
| 2026-08-12 | `PLAN_37_ipc-fast-read-readiness.md` | completed | Make fast IPC presentation complete and identity-safe | CHANGELOG_598 / REVIEW_238 |
| 2026-08-12 | `PLAN_36_remote-full-ui-parity.md` | delivery complete; installed acceptance pending | Complete source-authoritative Remote UI parity | CHANGELOG_592 / REVIEW_233 |
| 2026-08-11 | `PLAN_35_remote-transport-ui-convergence.md` | closed at user request | Fix Remote transport and UI; package without installed acceptance | CHANGELOG_591 / REVIEW_232 |
| 2026-08-10 | `PLAN_34_linux-deployment-automation.md` | completed | Add managed Relay, Worker, and Full deployment automation | CHANGELOG_584 / REVIEW_222 |
| 2026-08-09 | `PLAN_33_relay-quadlet-live-acceptance.md` | completed | Migrate AWS Relay to rootless Podman with an isolated Mac Worker | CHANGELOG_580-582 / REVIEW_219-221 |
| 2026-08-09 | `PLAN_32_remote-local-capability-parity.md` | completed with external acceptance | Complete Local/Remote parity and Workspace-sandbox delivery | CHANGELOG_578 / REVIEW_217 |
| 2026-08-08 | `PLAN_31_handoff-lifecycle-context-v2.md` | completed with documented residuals | Harden handoff context, lifecycle, and rollback boundaries | CHANGELOG_436 / REVIEW_216 |
| 2026-08-06 | `PLAN_31_linux-remote-core-foundation.md` | completed with follow-up | Deliver Remote Core, Relay/Worker, Feishu, and Workspace foundations | CHANGELOG_565 / PLAN_32 |
