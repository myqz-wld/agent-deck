# Recent Week Reviews

## Scope

This bucket contains only reviews that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `reviewed_at` is within the last 3 days, inclusive |
| `recent-week` | `reviewed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `reviewed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `reviewed_at` is older than 30 days, or missing a parseable date |

## Index Table

| reviewed_at | File | Topic | Severity Distribution |
|---|---|---|---|
| 2026-07-31 | `REVIEW_209_review-208-defect-remediation.md` | Final integration of all REVIEW_208 findings | 0 CRITICAL / 4 HIGH fixed / 10 MEDIUM fixed / 1 LOW fixed |
| 2026-07-31 | `REVIEW_208_compatibility-and-defect-audit.md` | Compatibility cleanup and functional defect audit | 4 HIGH / 10 MEDIUM / 1 LOW; closed by REVIEW_209 |
| 2026-07-31 | `REVIEW_207_exit-worktree-output-schema-compatibility.md` | MCP Zod output validation | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-07-31 | `REVIEW_206_runtime-selector-hook-security.md` | Runtime selectors and Hook security | 2 HIGH fixed / 1 HIGH superseded / 5 MEDIUM fixed / 2 MEDIUM residual / 2 LOW fixed |
| 2026-07-31 | `REVIEW_205_internal-compatibility-pruning.md` | Second-pass internal compatibility pruning | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed / 3 LOW fixed |
| 2026-07-31 | `REVIEW_204_compatibility-cleanup.md` | Current-only compatibility cutover and codebase slimming | 0 CRITICAL / 1 HIGH fixed / 5 MEDIUM fixed / 2 LOW fixed |
| 2026-07-31 | `REVIEW_203_hook-config-and-development-navigation-safety.md` | Hook ownership and renderer reload safety | 0 CRITICAL / 3 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-30 | `REVIEW_202_worktree-resume-recovery-race.md` | Revival-only worktree recovery | 0 CRITICAL / 1 HIGH fixed |
| 2026-07-30 | `REVIEW_201_legacy-exit-worktree-adoption.md` | Bounded legacy worktree exit | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed / 1 LOW fixed |
| 2026-07-30 | `REVIEW_200_automatic-worktree-transition-safety.md` | Automatic worktree cwd boundary | 0 CRITICAL / 3 HIGH fixed / 4 MEDIUM fixed / 1 LOW fixed |
| 2026-07-30 | `REVIEW_199_grok-application-id-fence.md` | Grok stable identity deletion fence | 0 CRITICAL / 2 HIGH fixed |
| 2026-07-30 | `REVIEW_198_grok-extension-terminal-delivery.md` | Real Grok terminal delivery | 0 CRITICAL / 2 HIGH fixed / 1 MEDIUM fixed / 1 LOW fixed |
| 2026-07-30 | `REVIEW_197_runtime-log-signal-quality.md` | Runtime log signal quality | 0 CRITICAL / 0 HIGH / 3 MEDIUM fixed / 1 LOW fixed |
| 2026-07-30 | `REVIEW_196_grok-durable-turn-delivery.md` | Durable Grok turn delivery | 0 CRITICAL / 2 HIGH fixed / 2 MEDIUM fixed |
| 2026-07-29 | `REVIEW_195_grok-live-acp-terminal.md` | Grok live ACP completion delivery | 0 CRITICAL / 2 HIGH fixed / 2 MEDIUM fixed |
| 2026-07-29 | `REVIEW_194_claude-gateway-sandbox-startup.md` | Claude Gateway sandbox startup | 0 CRITICAL / 2 HIGH fixed |
| 2026-07-29 | `REVIEW_193_grok-delivery-token-metric-scope.md` | Provider delivery, interrupts, and token fidelity | 0 CRITICAL / 3 HIGH fixed / 1 MEDIUM fixed / 1 INFO |
| 2026-07-29 | `REVIEW_192_grok-acp-silent-turn-recovery.md` | Grok ACP silent-turn recovery | 0 CRITICAL / 2 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-29 | `REVIEW_191_expandable-dialog-close-control.md` | Expandable dialog close control | 0 CRITICAL / 0 HIGH / 1 LOW fixed |
| 2026-07-29 | `REVIEW_190_first-message-image-control-spacing.md` | First-message image control spacing | 0 CRITICAL / 0 HIGH / 1 LOW fixed |
| 2026-07-29 | `REVIEW_189_grok-pending-chat-duplication.md` | Grok pending/chat duplication | 0 CRITICAL / 0 HIGH / 1 MEDIUM fixed |
| 2026-07-29 | `REVIEW_188_maintenance-timeout-terminal-policy.md` | Storage maintenance terminal timeout policy | 0 CRITICAL / 1 HIGH fixed / 1 LOW residual |
| 2026-07-29 | `REVIEW_187_whole-project-quality-refresh.md` | Whole-project final integration and performance audit | 0 CRITICAL / 4 HIGH fixed / 4 MEDIUM fixed / 1 LOW fixed / 5 residuals |
