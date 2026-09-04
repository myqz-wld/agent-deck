---
changelog_id: 628
changed_at: 2026-08-24
---

# CHANGELOG_628_native-project-trust: Add native project trust to session creation

## Summary

New Session and Issue resolution can now detect and explicitly persist provider-native project
trust for Claude Code, Codex CLI, and Grok Build. The same consent and authority model applies to
Desktop, Full, and Relay/Local Worker creation, while Pi remains a documented future adapter rather
than production code in this change.

## Changes

### Native provider trust

- Added one provider-neutral, revision-fenced trust descriptor with `trusted`, `untrusted`,
  `unknown`, and `unsupported` states. Paths and provider-home details remain private; public
  clients receive only a bounded reason and opaque SHA-256 revision.
- Detect and minimally merge Claude's per-directory `hasTrustDialogAccepted` decision under the
  effective native/Gateway state root. Malformed, oversized, symlinked, wrong-owner, or unsafe
  state is diagnostic-only and never overwritten.
- Detect Codex's exact cwd, project-root, and main-checkout trust precedence through app-server
  `config/read`; persist with native `config/value/write`, the base user-layer version, and a
  verification read.
- Detect Grok's most-specific safe ancestor decision and folder-trust gate. Desktop grants use
  native `--trust`; Core grants use the exact native `trusted_folders.toml` shape in its private
  persistent provider home.

### Consent and creation lifecycle

- Show an unchecked `信任此项目` option only for an authoritative, untrusted, grantable target.
  Claude, Codex, and Grok receive provider-specific effect copy; unknown/unsupported states show a
  diagnostic without a consent control and do not block creation.
- Bind consent to the exact authoring cycle, adapter, provider, cwd, and Remote source. It resets
  immediately across identity changes and is never stored in last-used defaults.
- Apply and verify an explicit grant only after Create, before attachment persistence and provider
  startup. A later create failure retains the native trust decision while preserving the authored
  message and images for retry.
- Reuse the workflow in Local and Remote Issue resolution. Non-UI and legacy callers that do not
  submit authoritative trust evidence retain their existing provider-native behavior.

### Remote and Grok container projection

- Bumped the public session-console capability/create schema to version 2 and the private
  provider-session launch schema to version 2. Older peers fail explicitly instead of dropping a
  consent request.
- Keep detection and persistence on the provider-owning Full Core or Relay Local Worker. Remote
  paths remain Workspace-relative, and trust failures map to bounded conflict/capability errors.
- Carry only a private boolean from Core to each disposable Grok provider container; the shim adds
  native `--trust` only when the persistent Core decision is currently trusted.
- Teammate spawn, handoff, and Feishu creation never grant trust implicitly; they submit a fresh
  no-grant revision and inherit only an already-persisted native decision.

### Pi design record

- Archived `PLAN_44_pi-adapter-project-trust.md` with the standalone-binary/RPC lifecycle,
  `.pi/` project configuration, native `trust.json` behavior, and the app-owned extension/private
  side-channel design for bridging Pi tools into the existing Agent Deck MCP dispatcher.
- Pi production code, permission popups, and OS sandbox support remain out of scope.
- The project README is intentionally unchanged following the user's documentation-placement
  correction; the focused Pi/trust design stays in the dedicated plan record.

## Validation

- `bash scripts/file-level-review-expiry.sh`
- `pnpm typecheck`: architecture, Core Node boundaries, and both TypeScript projects passed.
- `pnpm test`: 1,007 files and 6,307 tests passed; 2 files and 3 opt-in tests skipped.
- Focused provider/contract/Core/renderer suites passed after the final module split.
- `pnpm build`: main, preload, renderer, and build-info generation passed.
- `pnpm logger:check`
- `git diff --check`

## Do Not Split Protection

No exception is required. New trust modules are focused, and every changed production TypeScript
file is at or below 500 lines. The two pre-existing near-limit files expanded by this work were
split into dedicated project-trust contract/composition modules.

## Notes

- The coordinated schema bumps require Desktop/Core/Worker/provider-session components from the
  same release.
- Main and preload changed. Further process termination or development restart is intentionally
  left to the user following the explicit no-process-mutation direction.

## Related records

- `ref/plans/recent-month/PLAN_44_pi-adapter-project-trust.md`
- `ref/reviews/recent-3-days/REVIEW_262_native-project-trust.md`
