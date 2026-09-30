---
changelog_id: 647
changed_at: 2026-09-22
---

# Model Names and Native Defaults

## Summary

Ordinary Claude, Codex, and Grok sessions use explicit choices and provider configuration, leaving
model selection to the CLI when no model is configured. Refresh the requested model names in
bundled agents, MCP suggestions, and the isolated Grok broker configuration.

## Changes

### Model selection

- Remove the application-level `sonnet` and `grok-4.6` fallbacks from local new-session defaults
  and renderer initialization/error handling. Keep explicit remembered choices and configuration
  precedence; an empty model field produces no model override.
- Preserve empty models through the remote provider projection, Claude Gateway catalog, and
  Server Core defaults. Explicitly configured models still reach new sessions.
- Keep periodic summary and continuation checkpoint settings independent, including their
  existing Claude Haiku and Sonnet fallback routes.

### Model names and assets

- Change MCP suggestions from `gpt-5.6-sol/terra/luna` to `gpt-6-sol/terra/luna`, and from
  `grok-4.6/4.5` to `grok-4.7/4.6`. Preserve free-text model selection and override precedence.
- Remove the unused `SPAWN_SESSION_MODEL_VALUES` export and its test-only references. Keep model
  suggestions in the effective MCP runtime description and validate that public schema directly.
- Change the bundled Grok Reviewer to `grok-4.7`, retaining its `high` effort and role contract.
  Claude Reviewer remains `opus`; Codex Reviewer remains `gpt-6-astra`.
- The isolated Grok broker supplies `grok-4.7` through its generated CLI configuration and exposes
  `grok-4.7` and `grok-4.6` in its model directory.
- Update the normalization example and README configuration guidance. Historical records and
  tests using older model identifiers as arbitrary data retain their original identities.

## Validation

- `pnpm typecheck` passed, including architecture checks.
- Targeted defaults, projection, renderer, broker, MCP, and bundled-agent tests: 8 files and
  50 tests passed.
- `pnpm test`: 1,032 files and 6,400 tests passed; 2 files and 3 opt-in tests skipped.
- Typecheck and the complete test suite passed again after the unused-list cleanup. No source
  references to the removed export remain, and that declaration was already absent from the
  preceding production main bundle.
- `pnpm dist:mac` passed, including the production build and source/packaged macOS Worker sandbox
  checks. The regenerated app and DMG include this change and the preceding dependency refresh.
- Packaged main-bundle suggestions, the Grok Reviewer, and the provider shim match the updated
  source. All five upgraded dependency versions remain present in the ASAR.
- Checked 14,017 ASAR entries for unintended local configuration/log inclusion and 273 bundle
  files for personal filesystem paths and the local hostname; no matches were found.
- `hdiutil verify` passed. The SQLite binding hash remains unchanged.
- README/prompt local links, backup integrity, counterpart hashes, inventory refresh, changelog
  routing, and `git diff --check` passed.

## Do Not Split Protection

None. Modified production source files remain below 500 lines; the dependency lockfile retained
from the preceding refresh is exempt.

## Notes

- User Custom Points: none. The explicit model mappings and follow-up instruction for ordinary
  Claude sessions confirm scope and behavior. The user subsequently authorized removal of the
  redundant model list; no additional approval gate was required.
- Prompt-asset scope: README runtime configuration guidance, Grok Reviewer model metadata, MCP
  target-runtime model suggestions, and removal of the unused spawn suggestion constant. A fresh local
  seven-day inventory and backups record original/final hashes. Claude/Codex reviewer metadata
  and the three application-convention counterparts were checked and remain unchanged. Role
  bodies, permission boundaries, and adapter-specific differences are preserved. External links
  were not revalidated; no changed asset depends on a new external resource.
- Validation did not make authenticated inference requests. Model identifiers follow the user's
  requested mapping.
- The isolated Grok container gets a generated broker profile with a local proxy endpoint and an
  application-configured default model. Real credentials are injected at trusted Core egress;
  the proxy preserves the request body's model field. This container profile remains unchanged
  during the follow-up unused-list cleanup.
- The installed application remains running and unchanged. Installation/restart still requires
  approval under Host Runtime Safety; this change does not authorize that pending operation.
