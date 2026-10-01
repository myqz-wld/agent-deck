---
plan_id: 76
completed_at: 2026-09-30
status: completed
---

# Remote Worker activation and independent work

## Goal and authorization

Activate the confirmed Remote reconnect and independent owner-work repairs through the existing
explicit authorization to close, replace and reopen the formal Agent Deck application and upgrade
its configured managed Worker. Preserve pairing, provider controls, history and other tasks.

## Installed release

- Commit: `51e57942356b686975aaec25b50b743eac516617`.
- ASAR: `9407f89adc2016c3678924a2bc17aa2eaf6f91a5180d3df15f16ec24966d2862`.
- DMG: `dd92e702bc0ac0a1f0a97b6b41991c7f312c1a83f30bb4b2061ab7e26e0f5a95`.
- Main's separately completed Gateway recovery and its REVIEW_306/PLAN_75 were preserved.
  This repair is covered by [REVIEW_307](../../reviews/recent-3-days/REVIEW_307_remote-worker-backpressure.md)
  and [CHANGELOG_665](../../changelogs/recent-3-days/CHANGELOG_665_independent-work-remote-connection.md).

## Execution and verification

1. Validated the clean, merged release: 6,913 passing tests, six skips (three original and three
   opt-in native Gateway cases), types/architecture, builds, headless/deployment and packaged
   macOS sandbox checks. The shared Electron SQLite binding remained unchanged.
2. Audited 272 regular application files, 12,737 ASAR members, both embedded native archives and
   all headless outputs. No private machine/configuration markers were found. A signed staging
   copy and read-only DMG matched the release; neither was launched as a GUI application.
3. Used the official lifecycle to quiesce only the configured Worker/supervisor, privately backed
   up both Core SQLite databases, installed the prebuilt formal application once, upgraded Worker
   once and reopened the same application/session. Server and Feishu were not upgraded.
4. Independently verified the installed commit, ASAR and deep signature, one formal GUI process,
   Worker status and the existing connected Relay/Feishu backend. Application discovery contains
   only the formal installed app; the packaged copy and temporary registrations were removed.
5. Three concurrent approximately 42 KB history/event replies previously disconnected the shared
   attachment. The installed Worker now completes three rounds (nine replies) and a subsequent
   allowed read without reconnecting. Existing owner work is projected with no parent and depth
   zero; its title, assistant/work identities, remembered native controls and preferences remain.

The first installation job reported failure only because its final diagnostic called system.health,
which the Desktop grant correctly denies. Installation and Worker upgrade had already succeeded,
as had all concurrent reads. The diagnostic was corrected to an allowed session query, remaining
health checks passed and status was reconciled to completed. No reinstall, rollback, permission
change or repeated Worker upgrade was performed.

## Retention and handoff

The new DMG is retained in `build/dist/` and the verified prior package in
`build/dist/installed-3ea213cf/`. The older verified b48 package was removed, reclaiming approximately
763 MiB. Current pairing and configuration are intact; private recovery evidence stays outside Git.

The owner opened the actual Remote detail page and confirmed that it displays normally. The
shared screenshot shows rendered historical events. Independent hierarchy is separately verified
by the Core projection with no parent and depth zero.
Earlier manual rename/named-send acceptance and expired-card wording remain in their original
active Feishu plans. The older warm-channel stall is not retroactively attributed to this repair.

The related Workspace audit confirmed existing relative-directory selection through natural
create_work_session and /create, with 55 targeted path tests passing. /new uses the Workspace root;
/directories is a suggestion catalog. There is no dedicated filesystem-delete command; /delete
deletes a session record. No Workspace files or directories were deleted during this repair.
