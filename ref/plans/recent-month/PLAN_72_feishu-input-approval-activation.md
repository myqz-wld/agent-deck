---
plan_id: 72
completed_at: 2026-09-30
---

# Feishu input and approval release activation

## Goal and constraints

Activate the accepted rich-input/approval/progress release, restore the single formal application,
and preserve pairing, credentials, native model controls and assistant/work histories. The owner
explicitly authorized exact Desktop close/replace/reopen, managed Relay/Worker/Feishu upgrades,
and duplicate-package cleanup. No agents, worktrees or feature branches were created.

## Completed work

- Built and audited source `3ea213cf566413b268bca2ff007fa1100ee33f61` from clean main/origin/main.
  ASAR: `095757930f30bd4c3217abdad090518473fbd35ffd9af2accdb3028854e884d4`.
  DMG: `803dd00a2adc0bbc08afb9bc668ef447ad59972532543d694e2685f7f51e064d`.
- The first activation stopped during a local Docker Hub digest pull with EOF, before any remote
  installation or Desktop/Worker replacement. The owner subsequently launched the build-directory
  package while the formal bundle was still old, exposing two application entries.
- Recovery stopped the exact managed Worker and the sole temporary packaged GUI, installed the same
  accepted package through the official installer, reopened the formal application, upgraded Worker,
  and then retried the not-yet-applied Server/Feishu stages. Completion: 2026-09-30T16:07:10Z.
- Removed the temporary packaged application and stale Launch Services entries for build and hidden
  installer backup paths. Spotlight and Launch Services now identify only `/Applications/Agent Deck.app`;
  process inspection confirms a single GUI executing that formal bundle.
- Independently rechecked installed commit/ASAR, Worker/supervisor, Relay health, and Feishu/Core
  connection with identical active/desired runtime `9ce091778f5dc205c81e581ae51fb361c87d3f70851eee8dffc19b599b84fd44`.
- Preferences remain byte-identical: assistant Codex luna/max/native/on-request/Workspace, work
  Codex astra/medium/native/never/Workspace. Protocol remains 2.12 and Feishu SQLite remains v6.
- The exact retired 377/f4 Relay images were removed under stable manager-record and live/fallback
  checks, recovering sufficient capacity without changing data or protected active/fallback images.
- Retained current 3ea and verified b48 rollback DMGs. Removed the superseded 410 installer,
  reclaiming 799,488,842 bytes. Signature-copy and read-only DMG verification artifacts were cleaned.

## Validation

- Full suite: 6,881 passing tests, three existing skips. Two added Chinese/redaction tests pass
  separately. Typecheck/architecture, application/headless/native builds and deployment checks pass.
- Actual package: 273 application files, 14,547 ASAR members and both embedded native archives pass
  inclusion/privacy checks. Ad-hoc signing copy, read-only DMG and packaged Worker sandbox pass.
- Private execution, recovery, package, duplicate-registration and independent-health evidence remains
  under `$HOME/.agent-deck/diagnostics/app-replacement-3ea213cf/`. No credentials/configuration or
  private host identifiers are copied into this record.

## Final status and handoff

Installation and duplicate-app cleanup are complete. Do not reinstall this accepted package.
The owner-approved app-identity reaction grant is enabled. Browser confirms all current changes
are published, the existing 1.0.0 release remains published, and no extra draft is needed. Only that
permission was added; availability settings were left intact. The owner confirms the real assistant
reply and processing-to-completion reaction test succeeds. Natural work creation/approval acceptance
continues in the active Feishu plans. Earlier catgirl/test-word
acceptance remains valid; the old warm-channel stall's precise cause is still unproven.

[Release changes](../../changelogs/recent-3-days/CHANGELOG_663_feishu-input-approval-progress.md)
[Local review](../../reviews/recent-month/REVIEW_304_feishu-input-approval-progress.md)
