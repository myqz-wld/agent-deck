---
plan_id: 68
status: completed
completed_at: 2026-09-29
---

# Feishu assistant/work-session release activation

## Goal and constraints

Activate the user-authorized assistant/work-session separation through one exact Desktop replacement
and matching managed Relay, Worker and Feishu upgrades. Preserve histories, pairing, credentials,
native permissions and concurrent main work. Resume the same session; create no new agent.

## Completed activation

- Source release `f4bfeffd8187800fca378798283e8226f57dddc5` was validated, merged and pushed to main.
- The first launch failed before execution; the private launcher was made ASCII and validated with
  system Python. The subsequent Server attempt stopped before cutover at the disk-budget gate:
  409 MiB available, 555 MiB required. Desktop, Worker and Feishu were unchanged at that failure.
- Under existing cleanup authorization, removed 336 MiB of regenerable apt indexes and binary
  caches, holding package locks and excluding open files. The exact release budget then passed.
- Completed the official Server check/dry-run/upgrade/verify sequence. A separate remaining-stage
  runner reused the audited Desktop package, stopped the exact managed Worker, closed/replaced/
  reopened `/Applications/Agent Deck.app`, and completed Worker/Feishu upgrades and verification.
  The successful Server upgrade was not repeated.
- Independently verified the installed clean commit, exact archive hash, replacement GUI process,
  one canonical application discovery result, healthy Worker and provider-supervisor components.
- Feishu WebSocket and Core are connected, desired runtime is active, SQLite v5 passes quick_check,
  and accepted retention removed the obsolete release while keeping current and previous runtime.
- Read-only Core preference checks confirmed revision 2 and the owner's exact saved Codex models:
  assistant `gpt-6-luna` / `max`, new work `gpt-6-astra` / `medium`, native Gateway for both.

## Validation evidence

Integrated source passed architecture/typecheck, 6,767 tests with three existing skips, application
build, Linux reproducibility, both pinned Feishu runtime builds, headless/static/deployment gates,
and packaged macOS Worker sandbox checks. The actual ASAR and physical package passed private-value,
inclusion and native-ABI audits; disposable-copy signing and read-only DMG comparison passed.

- Installed commit: `f4bfeffd8187800fca378798283e8226f57dddc5`.
- Installed ASAR: `0e51d5fa1624a084d54232fe466e1f621cb10c690ca0a22be47e0b4ee5bab8d9`.
- Retained DMG: `8722bb2682051020a61796994d61edb5e395827155a7e640f9a49ace329805f7`.
- Active Feishu arm64 runtime: `16e58f4b22ebed92b516f1f736039e6ba34727e87a43f784323d505cdbf6d6fa`.
- Shared Electron SQLite binding remained unchanged throughout validation.

Raw logs, failed-stage evidence and completion/independent verification records remain private under
`$HOME/.agent-deck/diagnostics/app-replacement-f4bfeffd/`, outside distribution inputs.

## Artifacts and limits

The current DMG, block map, build metadata and checksums are retained in `build/dist/`; the previous
installer is in `build/dist/installed-377c8c77/`. Removed the verified superseded installers for
`6d4d44ad` and `3bb45616` (about 1.5 GB). No retained artifact was mounted or open. Installed app
signatures, working configuration, credentials, private recovery backups and unrelated files remain.

The small remote root filesystem has about 377 MiB free after cutover. Container storage increased
during this release; Feishu retention correctly keeps two releases. No volume resize was performed.
Run the full release disk budget before a future activation; current health is accepted, not a
claim of sufficient space for another upgrade.

Ordinary assistant replies are unlabelled plain text; work replies use session cards and independent
histories. Real two-turn context, natural-language management, work responses and pending-card
acceptance still require the owner's live Feishu round trip. Keep the conversational-bot and overall
Feishu plans active; do not claim business acceptance from runtime health.

## Final status and handoff

Installation acceptance and cleanup are complete. Official MCP restored this same session to main
and removed the clean release worktree. Deleted the merged local `fix/feishu-assistant-context`
branch after verifying main reachability; no remote feature branch was created. Both activation
jobs exited. Temporary probes and generated worktree copies were removed. Ongoing business plans
remain in `.ref/plans/`; unrelated workspace materials and user data were preserved.

Documentation-only commits after the installed source commit do not require another installation.
Continue actual owner Feishu acceptance using the saved model choices and separate assistant/work
commands. Do not recreate pairing or archive the overall business plan before live checks pass.

- [Source changes](../../changelogs/recent-week/CHANGELOG_659_feishu-assistant-contexts.md)
- [Review and validation](../../reviews/recent-week/REVIEW_299_feishu-assistant-contexts.md)
