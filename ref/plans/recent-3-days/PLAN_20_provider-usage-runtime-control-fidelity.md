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
related_changelog: CHANGELOG_401
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
| Claude permissions | Added `dontAsk` and `auto` through SDK, storage, recovery, IPC, and UI |
| Codex permissions | Provider-owned ordinary approval policy plus native app-server Pending requests |
| Sandbox propagation | Codex writable roots now include persisted `extraAllowWrite` |
| Grok controls | ACP-native permissions and work modes; foreign controls rejected |
| Surface contract | Shared adapter ownership across runtime profiles, CLI, IPC, MCP, and hand-off |
| MCP schema | Strict per-adapter schemas plus a documented flat transport projection |
| Structure | Extracted request, permission, and IPC helpers to keep changed facades under 500 LOC |

## Decisions

1. Approximate Claude thinking events are ignored for persisted usage, even when no exact result
   detail arrives. Absence is more truthful than a fabricated total.
2. Exact aggregate reasoning that cannot be assigned to a model stays in the existing fallback
   bucket; it is not proportionally distributed.
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

## Residual risk and next action

- A manual provider smoke remains useful for Claude `auto` / `dontAsk`, Codex native approval
  Pending rows, and Grok ACP permissions. It is not required for deterministic protocol
  correctness and was not run to avoid provider cost and external side effects.
- The public MCP JSON Schema cannot visually hide foreign fields until the tool API changes to
  separate adapter tools or a nested discriminated target. Runtime rejection is complete.
- First next action after merge: restart Agent Deck before manually exercising main/preload changes.

## Support materials

- Behavior record:
  `ref/changelogs/recent-3-days/CHANGELOG_401_provider-usage-runtime-control-fidelity.md`.
- Prompt-asset inventory:
  `.prompt-asset-improver/local/inventory.json` (ignored local workspace).
- Pre-edit restore manifest:
  `.prompt-asset-improver/local/backups/20260727T105940Z/manifest.json` (ignored local workspace).
