---
changelog_id: 425
changed_at: 2026-07-31
---

# CHANGELOG_425_codex-provider-hook-runtime-hardening: Restore native Codex providers and harden runtime boundaries

## Summary

Codex runtime selection again uses native `model_provider` ids throughout the current v60 runtime,
rather than advertising config profiles that the bundled Codex app-server cannot start. The same
delivery hardens Hook relay commands and hook-config file handling, tightens renderer navigation,
and publishes complete MCP runtime-selector contracts.

## Changes

### Codex provider compatibility

- Remove the unsupported `codex --profile <id> app-server --stdio` integration and always start the
  bundled app-server as `codex app-server --stdio`.
- Discover read-only model providers from `$CODEX_HOME/config.toml` and apply an explicit provider
  through app-server thread start, resume, recovery, and fork parameters.
- Keep current-v60 `sessions.runtime_provider`, summary/checkpoint settings, and bundled Agent
  overrides as native Codex `model_provider` ids. Older database/settings compatibility follows the
  repository's explicit current-only reset policy in REVIEW_204 and is not reintroduced here.
- Validate explicit provider selections before settings or bundled-Agent mutations. Loaded Codex
  sessions reject provider changes before persistence; dormant sessions apply a validated change at
  the next real recovery boundary.
- Honor `$CODEX_HOME` consistently in provider discovery, defaults, permission scanning, and the
  allowed config-file target.
- Restore Codex Agent metadata propagation for `config.model_provider`.

### Public runtime contracts

- Keep Claude Code's selector as `gateway` and restore Codex CLI's selector as `provider` across
  CLI, MCP spawn/handoff, preload, renderer, and shared types.
- Retain Codex `profile` only as a reject-only migration input with an actionable error.
- Publish strict `list_sessions` and `get_session` output schemas, including `gateway` and
  `provider`, and return matching structured content.
- Reject adapter-incompatible handoff selectors at schema validation time.

### Hook and navigation hardening

- Prefix generated Hook curl commands with `curl --disable` so a default curlrc cannot add another
  destination that receives the relay bearer token and hook stdin.
- Add a read-only relay inspector that checks the exact current command contract, regular-file
  identity, `0600` mode, content, and race stability.
- Reject dangling symlinks, live symlinks, and non-regular hook-config targets before reading;
  bound reads with no-follow/nonblocking descriptors and preserve compare-and-swap semantics.
- Permit renderer navigation only when both current and target URLs are same-origin HTTP(S),
  rejecting inherited-origin `blob:` navigation and other non-web schemes.

### Bundled instructions

- Align the paired Claude and Codex runtime instructions, MCP descriptions, schemas, and resource
  reference around Claude `gateway` / Codex `provider` ownership.
- Remove claims that Codex app-server supports native config-profile selection.

## Validation

- Focused post-rebase integration scope: 44 files and 498 tests passed.
- Full Electron-ABI suite: 439 files passed and 1 skipped; 3,645 tests passed and 1 skipped.
- Final MCP description/schema recheck: 3 files and 115 tests passed.
- `pnpm typecheck`, `pnpm build`, `bash scripts/logger-check.sh`, and `git diff --check` passed.
- A real bundled Codex 0.146.0 subprocess initialized app-server and returned the explicit
  `modelProvider` from `thread/start`.
- An isolated production-build Electron launch initialized schema v60 and bound its combined
  Hook/MCP server on a dynamically allocated loopback port.
- Eight prompt assets and all eight pre-edit backups passed SHA-256 verification.

## Notes

- Independent Codex config-profile selection remains unavailable until a pinned stable Codex
  release exposes an app-server-compatible native loader and passes a real packaged subprocess
  test.
- Non-v60 databases remain intentionally unsupported and fail without mutation under the
  current-only policy; this delivery does not add a legacy selector migration.
- Historical Hook ownership/migration remains outside this delivery. The relay inspector is ready
  but is not wired into adapter status until that separately owned migration branch is available;
  REVIEW_205 records the resulting residual risk.
