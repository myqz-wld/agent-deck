---
changelog_id: 687
changed_at: 2026-10-15
---

# Native child conversations and inline command output

## Summary

Child-agent details now reuse the parent conversation's message, thinking and tool rows. Newest
records appear first, with older records loaded below. The Activity tab's strip contains only
subagents. Background commands stay in their original Bash rows, and Tasks contains only Task
records.

The inner Activity/Output tabs are merged into one complete child conversation, using the same
message and tool disclosure controls as the parent.

These owner instructions supersede PLAN_97's shell-card and Tasks execution-history placement.
No separate fallback surface is provided for old commands without explicit tool associations.

## Changes

- Claude, Codex and Grok retain bounded optional role, opaque tool identity, status and exit
  metadata in child details. Explicit tool identities pair input and results; legacy records
  remain readable without guessing associations. Codex reasoning summaries display readable text.
- Child messages use the existing Markdown renderer and remembered disclosure state. Remove
  the redundant panel-wide text-mode toggle; individual bubbles retain their MD/TXT control. Child
  content remains read-only and cannot resolve parent approvals or access local attachments.
- Detail queries accept bounded descending pagination. The default ascending order remains for
  existing callers and command output. Message parts are reassembled in their original order.
- Claude/Grok background snapshots update their explicitly associated Bash row's status and
  output. The initial registration response is not treated as command completion. Detail reads
  start when output is expanded. Codex retains its original command stream and output path.
- Local and Remote share the same strip placement, child rendering and command association.
  Switching away from Activity unmounts the whole strip and its popovers; returning restores
  remembered expansion. Empty or command-only sessions consume no strip height.
- Remove the native execution-history section from Tasks and its unused component. Native
  events still belong to the main session's existing storage and deletion lifecycle. There is
  no schema change, history reset or new Task record.
- README contains only concise feature and usage text.

## Validation

- 45 focused tests passed across contracts, real SQLite pagination, all three adapter observers,
  child rendering, command ownership, remembered expansion and strip placement.
- `pnpm typecheck` passed, including architecture checks.
- `pnpm test`: 1,197 files passed, 3 skipped; 7,533 tests passed, 6 skipped.
- `pnpm build` passed. Typecheck, the full suite and production build were repeated successfully
  for the final release source after the panel controls and inner tabs were removed.
- After the owner's panel-toggle removal and inner-tab consolidation, 19 affected renderer tests and typecheck
  passed again. The production-component preview was rebuilt and reloaded; Browser confirmed
  one complete child conversation without the inner tabs or global text-mode button, with MD/TXT
  controls retained on individual bubbles. A refreshed screenshot was inspected.
- `git diff --check`, changed-file path/secret checks and the 500-line source guard passed.
  The shared SQLite binding checksum was unchanged. Generated text artifacts contained no
  actual home or checkout prefixes; broad matches were a validation regex and a vendor URL.
- Session-scoped Browser checks used real production components with synthetic data. Claude,
  Codex and Grok each showed three child cards, newest-first conversation rows, Markdown output
  and Bash output in the original conversation. Tasks/Changes had no strip; Activity restored
  expansion. Empty state returned 77 CSS pixels to the content area in the measured fixture.
  Local/Remote fixture modes verified client-side state separation; they are not live Remote
  transport tests. Console capture contained no errors. A full-page screenshot was inspected.

## Do Not Split Protection

None added. All changed/new source files remain below 500 lines.

## Related evidence and activation

See [REVIEW_334](../../reviews/recent-3-days/REVIEW_334_native-work-conversation.md) for association,
ordering and validation limits. The production-component preview remains intentionally non-final
under `.ref/prototypes/native-work-production/`; the earlier prototype is preserved.

Main-process changes require the revised application/runtime to be activated before live sessions
use the new metadata and descending queries. Release packaging and installation use the clean
main commit, with archive/privacy/signature checks and installed-version verification. Machine-local
package manifests and installer receipts remain private release material. README remains 62 lines.
