---
plan_id: 91
completed_at: 2026-10-14
status: execution-handoff
related_changelog: CHANGELOG_680
---

# Provider runtime and README refresh

## Goal and constraints

Refresh provider dependencies and application/Worker runtimes, and simplify README without changing
runtime policy. Use stable releases, preserve unrelated dependencies and external CLI overrides,
keep the SQLite binding intact, and avoid mutating live application processes during preparation.

## Completed preparation

1. Checked all six provider/protocol packages against current npm stable releases.
2. Updated Claude Agent SDK to 0.3.299 (Claude Code 2.1.299) and Grok to 1.0.52, including matching
   platform packages. Codex 0.162.1, Anthropic SDK 0.133.0, ACP 1.8.0, and MCP 1.32.1 remain current.
3. Reduced README from 89 to 47 lines and retained the separate bundled version table.
4. Validated imports, isolated native initialization, typecheck, all 7,254 tests, runtime preflight,
   macOS packaging, application/Worker version parity, archive privacy, and DMG integrity.
5. Recorded build-input fingerprints and confirmed the SQLite binding was unchanged.

## Package and activation handoff

Source and initial package validation are complete. Commit the scoped changes, regenerate metadata
and package from those unchanged runtime build inputs, and repeat final archive/Worker checks.
Keep checksums and portable package notes beside the installer in `build/dist/`.

Replacing the running application is a separate exact-target action. Before proceeding, obtain
approval to replace `/Applications/Agent Deck.app`, temporarily stop its verified Worker and Provider
supervisor services, and reopen the application afterward. Explain that hosted sessions may stop.
Use the existing managed installer with `--prebuilt --stop-running` only after approval, preserve
rollback behavior, and verify the installed commit, signature, provider versions, and restored services.

No installation or process restart is authorized by this plan itself. The prior permission-preview
tab and Browser skill are outside this task. External credentials and overrides remain untouched.

## Evidence

See `ref/changelogs/recent-3-days/CHANGELOG_680_provider-runtime-readme-refresh.md`.
The generated artifact report carries the exact final commit and checksums; source validation does
not by itself prove installed activation.
