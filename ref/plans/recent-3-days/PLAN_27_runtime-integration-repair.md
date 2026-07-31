---
plan_id: PLAN_27
title: Hook, Claude Gateway, and Codex provider integration repair
status: completed with documented residuals
created_at: 2026-07-31
updated_at: 2026-07-31
completed_at: 2026-07-31
base_branch: main
base_commit: f5e8bc5bbd02090d8817c5acac98c34c60d462a5
related_changelog: CHANGELOG_425
related_review: REVIEW_206
---

# PLAN_27_runtime-integration-repair: Repair reviewed runtime integrations

## Goal and invariants

- Repair the confirmed Hook, Claude Gateway, Codex provider, and cross-adapter defects without
  overwriting concurrent main-worktree changes.
- Keep current-v60 Codex sessions recoverable and never send unsupported profile argv to the
  bundled Codex 0.146.0 app-server.
- Preserve Claude Gateway lifecycle behavior while making public selector ownership exact.
- Do not recognize, migrate, delete, or test historical Hooks in this branch; that work remains
  owned by a separate branch.
- Do not write native user Codex/Claude configuration during implementation or validation.

## Confirmed design

- Codex uses native `model_provider` ids through app-server thread configuration. Independent
  `$CODEX_HOME/<name>.config.toml` profiles are removed until stable app-server support exists.
- Current-v60 durable bare strings retain provider meaning. Historical database/settings migration
  remains excluded by the repository's explicit current-only policy.
- Claude uses `gateway`; Codex uses `provider`; Codex `profile` is reject-only migration input.
- Loaded Codex sessions cannot hot-switch providers because the subscribed native thread ignores
  resume overrides. Changes fail before persistence; dormant sessions apply validated providers at
  recovery.
- Hook core gains curlrc isolation, safe filesystem snapshots, and a reusable relay inspector.
  Adapter status integration waits for the separately owned historical-Hook cleanup commit.
- Renderer navigation allows only same-origin HTTP(S) URLs on both sides of the comparison.

## Completed tasks

- [x] Create an isolated worktree and branch from immutable target `f5e8bc5b`.
- [x] Inventory and back up the eight approved AI-facing prompt assets.
- [x] Dispatch three disjoint Codex sub-sessions using `gpt-5.6-sol` with maximum reasoning for
      Codex provider compatibility, Hook core safety, and navigation policy.
- [x] Restore model-provider semantics across create/resume/recovery/fork/handoff, generators,
      settings, bundled Agents, CLI, MCP, preload, renderer, and shared types.
- [x] Add current-v60 persistence, custom-`CODEX_HOME`, mutation rollback, output-contract, hostile-curlrc,
      symlink/FIFO, and navigation regressions.
- [x] Align the paired Claude/Codex instructions and all approved MCP prompt/schema assets.
- [x] Run focused, full Electron-ABI, typecheck, build, logger, real Codex subprocess, and isolated
      Electron startup validation.
- [x] Archive changelog, review, and plan records and refresh prompt-asset hashes.

## Validation result

- Focused post-rebase integration: 44 files / 498 tests.
- Full Electron-ABI suite: 439 files passed and 1 skipped; 3,645 tests passed and 1 skipped.
- Typecheck, production build, logger check, whitespace check, real Codex 0.146 app-server smoke,
  and isolated Electron bootstrap passed.
- All eight pre-edit prompt backups remain byte-identical to their manifest hashes.
- No changed production source exceeds the 500-line guardrail; larger changed files are tests.

## Final status and residuals

Status: completed with documented residuals.

- Historical generated Hooks in uninspected scopes remain outside this plan.
- The relay health inspector is implemented but not connected to adapter status until the external
  historical-Hook branch is available, so relay drift can still produce an installed-status false
  positive.
- Native Codex config profiles remain intentionally unavailable pending stable app-server support.
- Non-v60 databases remain intentionally unsupported and are rejected without mutation; this plan
  does not restore historical selector migrations removed by the current-only cutover.

## Delivery and recovery

- Implementation branch: `fix/reviewed-runtime-integrations`.
- Pre-edit prompt backups:
  `.prompt-asset-improver/local/backups/20260731T112557Z/manifest.json`.
- The manifest maps each editable asset to its byte-identical original. Restore only the intended
  file from its listed backup; do not replace the full prompt set blindly.
