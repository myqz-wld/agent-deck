---
plan_id: PLAN_17
title: Bundled Agent runtime overrides
status: completed
created_at: 2026-07-23
updated_at: 2026-07-23
completed_at: 2026-07-23
base_branch: main
base_commit: b5a7725190b29556aeff9f326ba8feb0a20a8f11
related_review: REVIEW_168
---

# PLAN_17_bundled-agent-runtime-overrides: Configure runtime fields without editing assets

## Goal and invariants

- Let users configure runtime model and thinking/effort for built-in Agents in the Assets Library.
- Add provider selection only where the native adapter requires it; Codex needs an explicit
  `model_provider`, while Claude/Deepseek and Grok continue to use their own native configuration.
- Keep built-in prompt assets immutable and limit Restore Default to built-in assets.
- Do not alter user/project Agents or write any user-level Claude, Codex, or Grok configuration.
- Preserve runtime precedence: explicit spawn override, app bundled-Agent override, packaged Agent
  default, then native adapter default.

## Confirmed design decisions

- Store a small override record keyed by `adapter:name`, and consult it only for an Agent resolved
  from the bundled asset roots.
- Treat reset as deletion of the complete record so future packaged defaults can take effect.
- Permit only model, thinking/effort, and the currently necessary Codex provider field.
- Read Codex provider ids from native TOML only as UI suggestions; accept free text and pass the
  chosen id through the native Codex config override.
- Set only the Grok bundled reviewer default to `grok-4.5` / `high`; retain all other packaged
  defaults.

## Completed checklist

- [x] Inventory and back up the approved prompt/document assets.
- [x] Add typed settings, validation, persistence, IPC, and preload APIs.
- [x] Overlay effective bundled-Agent runtime metadata without mutating the raw asset cache.
- [x] Add Assets Library editing and whole-record Restore Default for built-in Agents only.
- [x] Add the read-only Codex provider suggestion parser.
- [x] Apply overrides in Claude/Deepseek, Codex, and Grok bundled-Agent spawn resolution.
- [x] Preserve explicit model/thinking precedence through the final SDK/ACP options.
- [x] Update the Grok reviewer packaged model and document native configuration ownership.
- [x] Add backend, runtime-routing, asset-overlay, provider-reader, and renderer tests.
- [x] Complete full validation, prompt-asset checks, review records, and isolated dev smoke.

## Validation and completion

- Full typecheck, test, build, logger, whitespace, plugin, prompt-asset, link, review-expiry, and
  file-size validation passed.
- The full suite passed 342 files and 2,986 tests, with one opt-in test skipped.
- The isolated Electron smoke reached `ready-to-show` with all four adapters and MCP initialized.
- No native provider config or packaged asset was rewritten during validation.

## Final status

Completed on 2026-07-23. The implementation deliberately does not introduce a universal provider
registry: each adapter owns its native backend configuration, while the app-level record contains
only the runtime selection required by a bundled Agent. A future adapter/provider field can extend
the same typed record after its native contract is known.
