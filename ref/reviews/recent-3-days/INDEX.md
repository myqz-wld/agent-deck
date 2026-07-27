# Recent 3 Days Reviews

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
| 2026-07-27 | `REVIEW_182_browser-engine-p0-p1-solo-audit.md` | Browser P0/P1 standalone Codex audit | 0 CRITICAL / 5 HIGH fixed / 6 MEDIUM fixed / 1 LOW fixed |
| 2026-07-27 | `REVIEW_181_provider-usage-runtime-control-fidelity.md` | Provider usage and runtime-control fidelity | Final PASS; AFR-001–012 closed |
| 2026-07-27 | `REVIEW_180_bundled-grok-package-preflight.md` | Bundled Grok package completeness | 0 CRITICAL / 1 HIGH fixed |
| 2026-07-27 | `REVIEW_179_transparent-scroll-compositor.md` | Transparent scroll compositor audit | 0 CRITICAL / 1 HIGH fixed |
| 2026-07-27 | `REVIEW_178_grok-tool-rendering-transparent-compositor.md` | Grok tool-event identity and transparent-window compositor refresh | 0 CRITICAL / 2 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-26 | `REVIEW_177_session-owned-iab-backend.md` | Session-owned Browser backend and dependency refresh | 0 CRITICAL / 1 HIGH fixed / 3 MEDIUM fixed |
| 2026-07-26 | `REVIEW_176_agent-plugin-recovery-state.md` | Claude/Grok Agent and Plugin recovery state | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed |
| 2026-07-26 | `REVIEW_175_node-repl-browser-process-bootstrap.md` | Browser process bootstrap compatibility | 0 CRITICAL / 1 HIGH fixed / 1 MEDIUM fixed |
| 2026-07-26 | `REVIEW_174_grok-custom-assets-test-isolation.md` | Grok custom-assets test isolation | 0 CRITICAL / 0 HIGH / 1 LOW fixed |
| 2026-07-26 | `REVIEW_173_tool-input-alias-recursion.md` | Renderer tool-summary alias recursion | 0 CRITICAL / 1 HIGH fixed |
| 2026-07-25 | `REVIEW_172_asset-library-cross-adapter-display.md` | Cross-adapter asset discovery and card layout | 0 CRITICAL / 0 HIGH / 2 MEDIUM fixed / 1 LOW fixed |
