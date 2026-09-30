---
plan_id: 66
completed_at: 2026-09-29
---

# Feishu model-selection release activation

## Goal and constraints

Activate the merged conversation and session model-selection release through the explicitly
authorized Desktop replacement and matching managed Relay, Worker and Feishu upgrades. Preserve
application data, provider credentials, existing owner pairing and concurrent repository work.
Resume the same session without creating an agent or repeating completed installation phases.

## Completed work

1. Merge and push source `377c8c772c8790fd2a0a452870f4d534b66351bd` to main. Remove the original
   feature worktree through official MCP and delete its local and remote branch after checking
   reachability and the remote tip. No replacement branch was created.
2. Rebuild the clean main release, regenerate stale generated Feishu archives and verify the
   actual package, runtime archive identities, signature procedure and read-only mounted DMG.
3. Upgrade the managed Relay Server through its official lifecycle. The first Desktop attempt
   correctly refused unrelated uncommitted files that another task added to main.
4. Preserve every concurrent change. Enter a temporary detached release worktree through MCP,
   reuse the verified package and complete only Desktop, Worker and Feishu recovery. The official
   installer closed, replaced and reopened the exact authorized application. The successful
   Server upgrade was verified without being repeated.
5. Independently verify the installed clean source commit, exact application archive and one GUI
   process. Worker, Relay and Feishu checks pass; Feishu WebSocket and Core are connected and its
   desired runtime is active. The optional provider supervisor is running with valid configuration.
6. Remove exact registrations for task-generated and nonexistent app copies. macOS application
   discovery returns only `/Applications/Agent Deck.app`. Installation jobs have exited; the app
   was not restarted again during closeout.
7. Save recovery evidence and the active bot plan in main, then exit the temporary release
   worktree through official MCP. Verify its directory is absent and only the main worktree
   remains. Concurrent confirmation-dialog and usage changes remain untouched and uncommitted
   by this task.

## Validation

- Integrated source validation: typecheck and 6,733 tests passed, with three existing skips.
  The final durability adjustment passed 19 focused tests and a final typecheck.
- Linux headless reproducibility, both Feishu runtime builds, deployment/package checks and the
  packaged macOS Worker sandbox gate passed.
- The actual package contains 14,547 archive entries with no excluded local metadata. Private
  value scanning passed for 273 physical app files. The embedded runtime archives match the
  regenerated artifacts; disposable-copy signing and strict verification passed.
- Installed commit: `377c8c772c8790fd2a0a452870f4d534b66351bd`, branch `main`, clean build metadata.
- Installed ASAR SHA-256:
  `d44f06707cfa0e550909bc584ed9032cb78adfdeb7ab51b6275d9cdda4d0b718`.
- Retained DMG SHA-256:
  `1cad23b2acdc529e18c42043456da218903628faf808528b95aef86cdd99fe65`.
- Active Feishu arm64 runtime SHA-256:
  `43e3d2100b59a07a1acd9984e82368cfdfc0fada909d91ffd28d0d32179bbb03`.

## Retained artifacts and cleanup

Retain `build/dist/Agent Deck-0.1.0-arm64.dmg`, private operational evidence and working deployment
configuration. Remove this task's redundant private prepared-build and pending-install application
copies only after verifying the retained and installed hashes and absence of process references.
Temporary signature and DMG probes, dependency links and release-worktree copies are removed.
Credentials, earlier recovery/configuration backups and unrelated artifacts remain protected.

Private completion evidence is under
`$HOME/.agent-deck/diagnostics/app-replacement-377c8c77/`; it is excluded from tracked records and
distribution inputs. The authoritative completion status records all activation gates as passed.

## Final status and handoff

Installation, duplicate-app cleanup and release-worktree cleanup are complete. Documentation-only
commits after the installed source commit do not require another build or installation.

The conversational-bot and overall Feishu plans remain active. Transport health does not establish
model-choice persistence, real provider replies, natural-language management or pending-card
acceptance. Continue those checks using the owner's saved choices; do not choose a fixed model or
repeat owner pairing.

- [Model-selection feature](../../changelogs/recent-3-days/CHANGELOG_657_feishu-conversation-model-selections.md)
- [Feishu event compatibility](../../reviews/recent-3-days/REVIEW_297_feishu-event-metadata.md)
