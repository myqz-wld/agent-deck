---
plan_id: 64
completed_at: 2026-09-29
---

# Desktop activation for Feishu acceptance

## Goal and constraints

Activate the repaired Browser controls and Claude permission-menu presentation through the
user-authorized close, replacement and reopen of the installed Agent Deck application. Preserve
application data, working credentials, managed deployment configuration and the existing Relay.
Resume the same session without creating another agent or repeating a completed installation.

## Completed work

1. Package clean `6d4d44ad987abbbaf39217178403437581dbc050` with `pnpm dist:mac` and inspect the
   actual application archive, physical files and read-only mounted DMG.
2. Use a private one-shot runner to stop only the configured managed Worker/supervisor, run the
   official prebuilt installer, reopen the exact app and restore the configured managed services.
3. Verify installed source metadata, archive hash, deep strict signature and one replacement main
   process. Official Worker, Relay and Feishu verification passed; Provider supervisor configuration,
   credential and service checks passed. No Relay Server deployment was required.
4. Confirm the installed renderer retains the base plan/no-prompt wording, removes parenthetical
   annotations and omits the no-prompt warning marker. Permission behavior and tooltips are unchanged.
5. Through the installed session-scoped Browser CLI, load the existing local Monaco fixture,
   discover and click the transparent labeled checkbox, replace JSON containing Unicode text and
   read the actual editor model. Both interactions passed. Close the fixture tab and exact server.
6. Restore the signed-in Feishu console and verify the saved receive-message event. Continue the
   separate callback, publication, pairing and real-chat acceptance plan without marking it complete.

## Validation

- Source validation before packaging: typecheck and 6,635 tests passed, with three existing skips;
  Linux/runtime builds and headless/static gates passed. Installer/process/managed-stop tests: 25 passed.
- Actual package: 14,547 archive entries, zero forbidden private members and no current private
  identifiers or credentials in 273 scanned physical application files.
- The raw builder bundle needed the installer's existing re-signing step. An isolated staging
  copy passed that procedure without changing its archive; the installed app also passed
  `codesign --verify --deep --strict`.
- Installed metadata is clean and identifies the exact packaged source commit. The mounted DMG,
  prepared bundle and installed archive match. The replacement runner completed and unloaded itself.
- Browser fixture acceptance checks semantic control state and the Monaco model. It does not
  claim arbitrary rich-editor coverage. A plain Feishu callback-tab div still lacks an actionable
  ref and requires one manual navigation step; the repaired checkbox/editor paths are active.

## Retained artifacts and cleanup

`build/dist/installed-6d4d44ad/` retains the accepted DMG, block map, updater/build metadata and
checksums. The previous accepted installer remains as one fallback. The installer removed the
duplicate packaged application; builder scratch, temporary signature staging and nine obsolete
Core/egress probe files were removed. Raw audit evidence remains private outside the repository.
Working Feishu inputs are retained until its separate business acceptance completes.

- DMG SHA-256: `a525590d44f3e7c5aea277617b62ad80b11264082a5aea275954ea2fabec84be`.
- App archive SHA-256: `173149b29f7220a1f38dd739d4e4e32c0c6cbe1ed96be7162e21b1a71eb48a5d`.

## Final status

Desktop installation and activation are complete. Documentation-only commits may follow the
installed source commit without requiring another installation. Feishu transport is healthy;
callback publication, owner pairing and real provider replies remain separate acceptance work.

- [Browser repair](../../reviews/recent-month/REVIEW_290_browser-styled-controls-monaco.md)
- [Claude menu presentation](../../reviews/recent-month/REVIEW_294_claude-permission-indicators.md)
- [Feishu backend recovery](../../reviews/recent-month/REVIEW_295_feishu-bootstrap-runtime-recovery.md)
