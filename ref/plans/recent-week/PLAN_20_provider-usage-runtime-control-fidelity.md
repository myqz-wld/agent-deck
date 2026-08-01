---
plan_id: PLAN_20
title: Provider usage and runtime-control fidelity
status: completed
created_at: 2026-07-27
updated_at: 2026-07-27
completed_at: 2026-07-27
base_branch: main
base_commit: abc9f8180a9e1e4b828a06c7ae5fff99a6af47a2
initial_worktree_base: 98471b111f99515827cb90d8384fab814994bf4f
implementation_commit: e759093a2d9bdce0668a8023d24aa06774c0723d
related_changelog: CHANGELOG_402
---

# PLAN_20_provider-usage-runtime-control-fidelity: Preserve provider truth

## Goal and invariants

- Persist and aggregate only token values explicitly returned by the provider.
- Missing provider usage remains unavailable; no heuristic token count becomes historical usage.
- Token/s stays a lightweight transient display and never feeds totals.
- Claude Code, Codex CLI, and Grok Build expose only controls their provider can honor.
- Runtime creation surfaces reject incompatible fields rather than silently filtering them.
- No filesystem, network, approval, or tool permission is widened during normalization.

## Completed work

| Area | Result |
|---|---|
| Claude usage | Removed approximate thinking-token persistence; exact result detail only |
| Codex usage | Removed reasoning double-count; preserved cache-write usage; added exact v048 repair |
| Grok usage | Preserved exact cached-write usage in live and history imports |
| Claude permissions | Exposed manual, accept-edits, plan, auto, and bypass; retired public `dontAsk` |
| Codex permissions | Provider-owned ordinary approval policy plus native app-server Pending requests |
| Sandbox propagation | Codex writable roots now include persisted `extraAllowWrite` |
| Grok controls | ACP-native permissions and work modes; foreign controls rejected |
| Usage storage | Nullable provider values plus explicit per-metric applicability |
| Surface contract | Shared adapter ownership across runtime profiles, CLI, IPC, MCP, and hand-off |
| MCP schema | Strict per-adapter schemas plus a documented flat transport projection |
| Structure | Extracted request, permission, and IPC helpers to keep changed facades under 500 LOC |

## Decisions

1. Approximate Claude thinking events are ignored for persisted usage, even when no exact result
   detail arrives. Absence is more truthful than a fabricated total.
2. Claude assistant frames are never persisted as durable usage. The authoritative result is the
   sole durable source. A single model may inherit exact aggregate fields omitted from its detail;
   multi-model aggregate reasoning that cannot be attributed stays in a reasoning-only fallback
   bucket and is never proportionally distributed.
3. v048 repairs only historical Codex rows whose separately stored reasoning value makes the
   correction exact. It does not guess for older rows.
4. Ordinary Codex sessions omit `approvalPolicy`; reviewer-codex explicitly retains `never` so an
   invisible non-interactive reviewer cannot stall.
5. Grok receives no synthetic Claude/Codex sandbox. ACP permission requests remain authoritative.
6. MCP keeps its existing flat call signature. Local SDK probes showed that a top-level
   discriminated union serializes as an empty object and arbitrary conditional schema metadata is
   stripped. Adapter-specific schemas therefore drive ownership/tests, while handlers enforce the
   contract at runtime.
7. The original Browser Host investigation is excluded because current `origin/main` already
   contains the cross-adapter browser implementation.
8. Claude `dontAsk` is not a user-facing mode. A provider-reported or stored state is preserved
   exactly for the current session and dormant recovery, and shown read-only in the UI. It is not
   accepted by CLI/IPC/MCP or offered by selectors; a fresh spawn/fork/handoff falls back to
   `default` instead of propagating the provider-only state. Internal tool-free one-shot calls may
   still use the SDK mode.

## Review follow-up

The post-implementation adapter-fidelity review found recovery and missing-value gaps that the
initial validation did not exercise. The follow-up delivery:

- requests `excludeTurns` for Codex resume/fork so app-server does not replay historical turn usage;
- persists explicit per-session Codex approval overrides so reviewer `never` survives dormant
  recovery, restart, native fork, and hand-off, while ordinary sessions remain provider-owned;
- accepts authoritative Claude `auto` and provider-only `dontAsk` status updates, while keeping
  `dontAsk` unavailable on public mutation surfaces;
- persists Grok cumulative ACP usage watermarks and treats the first snapshot of a legacy recovered
  session as a baseline rather than a new turn;
- makes token usage fields presence-aware, preserves exact provider totals, and never converts an
  unreported Grok metric into zero;
- reports the reviewer session's actual Codex approval override in the permission audit panel.

The first follow-up review then found eight additional fidelity gaps. The remediation:

- defers all Claude persistence until the authoritative result, so assistant-frame partial values
  cannot turn an otherwise exact day into a permanently incomplete one;
- records a metric applicability mask alongside nullable values, allowing unattributed
  multi-model Claude reasoning to remain exact without claiming unrelated metrics are zero or
  unavailable;
- commits each Grok usage row, provisional-row replacement, and cumulative watermark in one SQLite
  transaction;
- preserves partial and total-only Grok extension payloads, correlates late extensions with the
  provisional ACP snapshot, and reconciles history backfill without double counting;
- inherits reviewer Codex approval/network/directory controls through native same-adapter forks and
  backfills the explicit reviewer `never` override for recognizable legacy reviewer sessions;
- conservatively migrates ambiguous pre-v051 zero metrics to unavailable, because the old schema
  could not distinguish provider-returned zero from an inserted default;
- gives Grok an ACP-native permission panel and skips Claude/Codex permission scanners entirely.

The second follow-up review found four additional lifecycle/display gaps. The remediation:

- returns unavailable, not zero, when every daily row marks a metric out of scope;
- preserves provider-restored Claude `dontAsk` through storage, query construction, and dormant
  recovery, renders it as a read-only current state, and keeps all public/new-session choices on
  the five supported modes;
- classifies Grok corrections for completed turns independently of the current turn's 100 ms
  standard-usage grace window, so a late prior extension neither cancels nor completes the active
  turn and never advances an uncommitted current watermark;
- reconciles cache-write-only and reasoning-only Grok extension/history rows by contradiction-free
  matching within a tight timestamp window, while retaining wider matching only when metrics
  actually overlap.

The third follow-up review confirmed the display/Claude-mode fixes and found three deeper Grok
correlation gaps. The remediation:

- classifies an explicitly older extension as historical before compatibility matching, so even a
  corrected/contradictory metric cannot cancel or canonicalize the active turn;
- advances only the newly discovered portion of a completed prompt's cumulative frontier, persists
  only the safe corrected turn-start baseline, and recomputes an in-grace current delta in place;
- requires a unique, model-compatible zero-overlap fallback candidate and treats an existing
  canonical prompt id as an idempotent upsert rather than searching for another fallback.

The fourth follow-up review found one remaining order-dependent Grok frontier case. The remediation
records, per metric, when an exact cumulative snapshot already covers a value whose current-turn
delta is unknown. A matching current, late, or progressive extension may then fill the canonical
turn row without adding that metric to the frontier a second time.

The fifth follow-up review found the complementary fresh-session boundary. The remediation treats a
fresh first cumulative snapshot as attributable current-turn usage, so a larger in-grace extension
advances only its correction and the next cumulative snapshot subtracts the corrected frontier.
Legacy baseline-only recovery and per-field unknown persisted watermarks retain their coverage
protection.

The sixth follow-up review found that a second progressive extension could arrive before grace
cleanup and erase that per-prompt coverage metadata. The remediation preserves the retained
standard event and covered scope across back-to-back notifications, excludes already-covered
metrics, and advances any genuinely uncovered correction before the next cumulative snapshot.

## Validation performed

- Final branch rebased onto `origin/main@abc9f818`.
- `pnpm typecheck` passed.
- `pnpm test` passed 383 files and 3,198 tests; one explicit live smoke test skipped.
- `pnpm build` passed.
- `pnpm logger:check` passed.
- `git diff origin/main...HEAD --check` passed.
- `bash scripts/file-level-review-expiry.sh` ran.
- New/changed production facades are at or below 500 lines. The one remaining changed production
  file above the limit is the pre-existing Claude message dispatcher, reduced from 700 to 688 lines
  with its new accounting already extracted.

Review-follow-up validation on `9baa1e4c` plus the working-tree fixes:

- `pnpm typecheck` passed.
- Electron-ABI `pnpm test` passed 386 files and 3,245 tests; one explicit paid live smoke test
  remained skipped.
- `pnpm build`, `pnpm logger:check`, `bash -n resources/bin/agent-deck`, and
  `git diff --check` passed.
- SQLite tests executed migrations v049-v051 against existing rows and exercised nullable metrics,
  metric applicability, exact provider totals, index recreation, session rename, atomic cumulative
  watermark commits, rollback, and provisional/history replacement.
- The sixth follow-up Grok/storage suite passed 71 tests, including explicit-old contradictions,
  progressive optional metrics before and during the next turn's grace window, ambiguous
  zero-overlap candidates, repeated history backfill, and unknown-baseline cumulative coverage
  before and after grace, plus covered and uncovered back-to-back progressive notifications before
  cleanup and their next cumulative deltas; the final full suite includes all of them.
- The same `gpt-5.6-sol max` reviewer completed seven rounds and returned an unambiguous PASS with
  no actionable findings; AFR-001 through AFR-012 are closed.

## Residual risk and next action

- A manual provider smoke remains useful for Claude `auto`, Codex native approval
  Pending rows, and Grok ACP permissions. It is not required for deterministic protocol
  correctness and was not run to avoid provider cost and external side effects.
- The public MCP JSON Schema cannot visually hide foreign fields until the tool API changes to
  separate adapter tools or a nested discriminated target. Runtime rejection is complete.
- First next action after merge: restart Agent Deck before manually exercising main/preload changes.

## Support materials

- Behavior record:
  `ref/changelogs/recent-3-days/CHANGELOG_402_provider-usage-runtime-control-fidelity.md`.
- Final review:
  `ref/reviews/recent-week/REVIEW_181_provider-usage-runtime-control-fidelity.md`.
- Prompt-asset inventory:
  `.prompt-asset-improver/local/inventory.json` (ignored local workspace).
- Pre-edit restore manifest:
  `.prompt-asset-improver/local/backups/20260727T105940Z/manifest.json` (ignored local workspace).
