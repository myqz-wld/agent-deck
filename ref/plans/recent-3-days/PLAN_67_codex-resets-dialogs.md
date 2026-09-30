---
plan_id: 67
completed_at: 2026-09-29
status: completed
---

# Codex resets and application dialog consistency

## Goal and accepted decisions

Add quota-reset availability and confirmed use to the usage panel. The user first
requested an IAB preview, then approved a smaller confirmation containing only a
provider-specific title, one consumption sentence, and two buttons. The final
count/action row uses small text on one line. The scope was expanded to inspect
all application dialogs and unify their presentation.

The user explicitly chose to preserve switching behavior: do not introduce an
extra confirmation for Codex approval policy `never`.

## Constraints

- Reuse ordinary usage responses for counts; do not poll a separate details API.
- Show use only for known positive counts with a usable source/account binding.
- Require explicit confirmation; prevent duplicate logical consumption with a
  stable idempotency key and one active request per authority.
- Reconcile from new provider data; distinguish failure, unknown state, and zero.
- Keep credentials and real account identifiers out of records and fixtures.
- Do not mutate live runtime settings, consume real credits, or restart the app.

## Completed work

1. Verified Codex 0.159.2's generated protocol and actual read-only responses.
   Counts are available through `account/rateLimits/read` with
   `excludeResetCreditDetails: true`. Grok billing and Claude's SDK did not
   establish a reset-redemption contract. See the
   [interface evidence](codex-reset-interface-evidence.md).
2. Added typed provider normalization, Local IPC, Remote Core mutation admission,
   account matching, idempotent consumption, and cache-generation invalidation.
3. Added the compact quota row and short application confirmation. Retained
   ambiguous attempt keys across view changes and protected source-switch races.
4. Inventoried all sixteen modal frame components, all simple confirmation callers,
   and native dialog entry points. Shared normal dialog chrome and modal keyboard
   handling without resizing content-heavy viewers into confirmation layouts.
5. Completed targeted and full validation, a Browser preview of the actual React
   components with synthetic callbacks, and the final records below.

## Validation

- Architecture/type checks and the production build passed.
- Full Electron test run: 6,758 passed, 3 pending, zero failed in 1,094 files.
- Browser checked compact count text, modal focus/isolation, cancel, simulated
  redemption, and the sandbox confirmation example. The final component preview
  was inspected at a 420 x 480 CSS pixel viewport; the earlier static design was
  also checked at wider widths. No live consumption or runtime switch was tested.
- Final record bucket audit found no existing records needing relocation.

## Handoff

Source implementation and validation are complete. Main/preload activation needs
an authorized application restart; no such process action was performed.
The IAB component preview is intentionally retained as non-final workspace data
under `.ref/previews/quota-reset/`. Temporary validation helpers and archived
evidence duplicates were removed after validation.

- [Changelog](../../changelogs/recent-3-days/CHANGELOG_658_codex-resets-dialogs.md)
- [Review](../../reviews/recent-3-days/REVIEW_298_dialogs-quota-reset-safety.md)
