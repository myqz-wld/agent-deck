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
| 2026-07-15 | `PLAN_14_checkpoint-patch-reduction.md` | completed | Let the LLM emit semantic patches while code owns checkpoint state | REVIEW_163 |
| 2026-07-15 | `PLAN_13_history-search-case-insensitive.md` | completed | Rebuild History FTS case-insensitively while fully offline | CHANGELOG_374 |
| 2026-07-14 | `PLAN_12_handoff-ownership-plan-review-hardening.md` | completed | Preserve current-owner authority and harden plan-review lifecycle | CHANGELOG_366 / REVIEW_161 |
| 2026-07-14 | `PLAN_11_automatic-continuation-checkpoints.md` | completed | Keep continuation state fresh without unbounded growth | CHANGELOG_365 / REVIEW_160 |
| 2026-07-14 | `PLAN_10_present-plan-deep-review.md` | completed | Retain blocking plan gates and add isolated contextual review | CHANGELOG_364 / REVIEW_159 |
| 2026-07-14 | `PLAN_9_runtime-controls-handoff-context.md` | completed | Auto-save runtime controls and restore hand-off coverage | CHANGELOG_363 / REVIEW_158 |
| 2026-07-12 | `PLAN_8_core-snapshot-ui-copy-review.md` | completed | Audit core snapshots and simplify user-facing copy | REVIEW_154 |
| 2026-07-12 | `PLAN_7_storage-maintenance-worker-provider-compaction.md` | completed | Isolate live storage maintenance and restore compact generation | CHANGELOG_362 / REVIEW_153 |
| 2026-07-11 | `PLAN_6_storage-performance-observability-svg-icons.md` | completed | Stage storage maintenance and unify renderer SVG icons | CHANGELOG_361 / REVIEW_152 |
| 2026-07-11 | `PLAN_5_unified-continuation-context.md` | completed | Unify provider-neutral continuation context | CHANGELOG_358 / REVIEW_148 |
| 2026-07-11 | `PLAN_4_session-pinning-reviewer-model.md` | completed | Add persistent Live pins and Codex reviewer default | CHANGELOG_359 / REVIEW_149 |
| 2026-07-10 | `PLAN_3_codex-collaboration-raw-events.md` | completed | Restore fresh Codex collaboration events | REVIEW_147 |
| 2026-07-09 | `PLAN_2_spawn-session-native-fork.md` | completed | Add safe provider-native parallel forks | CHANGELOG_353 / REVIEW_144 |
| 2026-07-09 | `PLAN_1_project-engineering-foundation.md` | completed | Align Repository Engineering Foundation | CHANGELOG_349 |
