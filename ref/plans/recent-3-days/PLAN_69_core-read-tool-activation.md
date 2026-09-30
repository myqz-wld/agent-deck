---
plan_id: 69
status: completed
completed_at: 2026-09-30
---

# Activate Server Core read-only tool annotations

## Goal and constraints

Activate the six corrected read-only MCP descriptors in the installed Desktop/Worker while
preserving the owner's assistant history, work selection, models and native permission policy.
Use the existing exact-target close/replace/reopen authorization and resume the same session.

## Completed work

1. Commit and push source `0a4299b96ce21a66a0b22186dd021c589adddead` on main after validation.
2. Preserve the accepted `f4bfeffd` installer. Reuse its pinned Feishu archives after proving both
   gateway payloads match the current build byte-for-byte. Prepare and audit a clean macOS package.
3. Verify the existing Relay and Feishu before activation. Stop the configured managed Worker,
   use the official prebuilt installer to close/replace the exact installed app, reopen it and
   complete the official Worker check/dry-run/upgrade/verify sequence.
4. Verify the existing Relay and Feishu again. No Server/Feishu upgrade, database migration,
   cloud resize or pairing operation was performed.
5. Independently verify the clean installed commit, exact ASAR, replacement GUI process and one
   canonical application discovery result. Worker and provider-supervisor checks pass. The installed
   Worker bundles match the validated build and contain all six read-only annotation assignments.
6. Confirm the one-shot installation job exited. Remove temporary signing/mounting probes and the
   obsolete `377c8c77` installer; retain the current package and one accepted `f4bfeffd` fallback.
   This repair used main and created no feature branch or worktree.

## Validation

Source validation passed four new regressions, 12 focused checks, all 6,771 tests with three existing
skips, architecture/typecheck and headless/deployment checks. The actual package passed its macOS
Worker sandbox gate, 14,547-member inclusion audit, 273-file privacy scan, disposable-copy signing
and read-only DMG comparison.

- Installed commit: `0a4299b96ce21a66a0b22186dd021c589adddead`.
- Installed ASAR: `775768d10182a97d6f4d33c9b7e60519660d78c8bf5e48eb99e181bae073070c`.
- Retained DMG: `c43351f423035991789c3797870e8e55809e9707edac1767789a825306aad641`.
- Existing Feishu runtime: `16e58f4b22ebed92b516f1f736039e6ba34727e87a43f784323d505cdbf6d6fa`.
- Feishu WebSocket/Core connected; saved approval policy and model selections are unchanged.

Private evidence is under `$HOME/.agent-deck/diagnostics/app-replacement-0a4299b9/`.
Current installer files and checksums are in `build/dist/`; one fallback remains in
`build/dist/installed-f4bfeffd/`. Credentials, pairing and recovery evidence remain private and intact.

## Final status and continuing acceptance

Installation and cleanup are complete. The owner has already accepted ordinary assistant text,
cross-turn recall and a fast second reply. After this activation, the owner was asked to retry a
read-only work-session list in the existing assistant chat. Its real MCP result, work-session
creation/message cards and one pending-card decision remain business acceptance checks.
Keep the Feishu workspace plans active. Documentation-only updates do not require another install.

- [Repair and validation](../../reviews/recent-3-days/REVIEW_300_core-read-tool-annotations.md)
