---
plan_id: 63
completed_at: 2026-09-29
---

# Grok credential synchronization and installed acceptance

## Goal and constraints

Resolve the reported stale Worker-local Grok credential, restore the headless source-size gate,
and complete the explicitly authorized application close, replacement and reopen. Include the
subsequently requested inline diff spacing/readiness fix and concise English README.

Preserve native credentials, private deployment configuration, unrelated application copies and
Relay Server. Project only access-token/expiry fields into the exact Worker. Use official Worker
deployment and the local installer. Keep raw diagnostics outside version control and packages.

## Completed work

1. Implement host-owned startup/30-second credential synchronization, actual deployed-copy health
   checks and accurate Grok capability diagnostics. Split the two modules that blocked the
   500-line headless gate. Merge to main and remove the feature branch/worktree.
2. Preserve retained installers during builds, add clean-source prebuilt installation, and stop
   only the verified managed Worker/supervisor jobs before application replacement.
3. Move the inline diff expand action into the title row. Share the 150 ms loading grace across
   payload and Monaco initialization, reserve height and reveal only the computed, laid-out diff.
4. Reduce README to 47 English-only lines with links to detailed documentation.
5. Build, inspect and install clean `3bb45616c0258fbb9b04da2b1c5e6a4e82d1dbb6`. A bounded private
   launchd task completed the approved lifecycle and resumed this same application session.
6. Complete Worker/Relay acceptance and resolve issue `611fdd74-7a9f-4f61-af96-d85961696739` through
   MCP. Archive this plan, remove temporary probes and superseded/reproducible build outputs.

## Validation

- Final source typecheck passed; full tests: 6,587 passed, 3 existing skips across 2 files.
- Headless gate, deployment checks, macOS packaging and packaged Worker sandbox checks passed.
- Synthetic Browser inspection used the real components and Monaco. The header gap was 4.375 CSS
  pixels. Cached reopen finished at 118 ms without progress text; a 500 ms payload delay showed
  progress at 154 ms, retained it through editor initialization and cleared it at readiness.
  Enlargement and close worked; the test tab/server were closed. No installed-app visual claim
  extends beyond this fixture viewport and the verified source/package identity.
- Actual package inspection covered 14,538 archive entries and 273 application files. No excluded
  local agent configuration or current private home/checkout/host identifiers were found.
- Mounted DMG metadata/archive matched the prepared app. Installed metadata is clean, its archive
  hash matches and the exact replacement main process was verified. Installer signature checks passed.
- Official Worker check, dry-run, upgrade and verify passed. Supervisor configuration, credential
  health and service are healthy; the synchronization arguments are active.
- Five Relay isolation cycles passed with retries disabled and zero failures. Grok remained enabled
  and client retirement preserved the Worker SSH attachment. No Relay Server deployment occurred.

## Retained artifact and cleanup

`build/dist/installed-3bb45616/` contains the accepted DMG, block map, updater/build metadata and
checksum. It remains inside the explicitly excluded distribution-output subtree.

- DMG SHA-256: `8298fcf30113fb9e7468265723efc297376e877a0241b87f4e2f7df13397766a`.
- App archive SHA-256: `e80a39ca8abf024a1f5fc45f2cf2a89fdc0173fc8552d478fe0363b4cf55bb61`.

After live acceptance, remove both older installers and 249 generated build files. Build usage
fell from about 2.89 GiB to 676 MiB, reclaiming about 2.23 GiB. Remove the active plan and two Relay
probes from `.ref`; private diagnostic evidence remains outside the repository. The one-shot job
is unloaded and the duplicate packaged application was removed by the installer.

## Final status

Implementation, installation, live acceptance and issue resolution are complete. Native OAuth
renewal remains host-owned; valid source changes are observed by the managed synchronization loop.
Final documentation commits may follow the installed source commit without changing runtime code.

- [REVIEW_287](../../reviews/recent-month/REVIEW_287_grok-credential-projection-refresh.md)
- [REVIEW_288](../../reviews/recent-month/REVIEW_288_hosted-app-replacement.md)
- [REVIEW_289](../../reviews/recent-month/REVIEW_289_inline-diff-readiness.md)
