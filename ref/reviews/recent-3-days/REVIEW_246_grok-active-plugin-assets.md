---
review_id: 246
reviewed_at: 2026-08-13
baseline_commit: 12d602bfd28c581ae680efc4796f8e3cabdc201d
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Final review record and index maintenance are mechanical evidence derived from the reviewed tree."
---

# REVIEW_246_grok-active-plugin-assets: Grok active Plugin asset discovery

## Scope and method

Reproduced the Grok Assets Library duplication against a home containing six historical Claude
Plugin cache versions, compared the result with Grok Build's native `plugin list` and `inspect`
inventories, and traced local and Server Core discovery from install state through asset metadata.

```review-scope
src/hosts/server-core/node-asset-user-scan.test.ts
src/hosts/server-core/node-asset-user-scan.ts
src/main/adapters/grok-build/__tests__/custom-assets.test.ts
src/main/adapters/grok-build/custom-assets.ts
src/main/adapters/grok-build/plugin-search-paths.ts
```

## Findings

### MEDIUM — Grok cataloged every historical Claude Plugin cache version

Grok user discovery recursively walked all of `~/.claude/plugins`. Claude retains old package
versions under `plugins/cache`, so each cached directory became a separate Grok Plugin root and
duplicated every Skill. Discovery now reads Claude's `installed_plugins.json` and visits only its
current `installPath` entries, while preserving direct non-cache Plugin directories.

### MEDIUM — Native Grok installed Plugins were absent from the asset inventory

The scanner covered legacy `~/.grok/plugins` and compatibility directories but not the native
`~/.grok/installed-plugins/registry.json` roots. It also ignored `.grok-plugin/plugin.json` and
`.claude-plugin/plugin.json`, causing version-directory fallback names. Discovery now includes
enabled native Grok registry roots locally, installed registry roots on Server Core, and all three
supported manifest layouts.

### LOW — Grok Plugin TOML arrays were parsed from an empty section

The multiline section expression allowed the end-of-line anchor to terminate immediately after
`[plugins]`, so configured `paths` and `enabled` arrays could be ignored. The replacement isolates
the complete section before parsing bounded string arrays.

## Fixes landed

- Added one bounded Plugin-state resolver for native Grok registry roots, active Claude install
  paths, explicit Grok paths, and direct compatibility Plugin directories.
- Deduplicated discovered Grok Plugin roots by manifest name before listing or Agent resolution.
- Applied the same active-version policy to local and Server Core asset inventories.
- Added regression coverage for stale/current Claude cache versions, enabled/disabled native Grok
  Plugins, `.grok-plugin` and `.claude-plugin` manifests, and canonicalized Provider Home paths.

## Validation and evidence

- `pnpm typecheck` passed, including architecture boundary checks.
- Targeted Grok and Server Core asset suites passed: 3 files, 13 tests.
- `pnpm test` passed.
- `pnpm build` passed.
- `git diff --check` passed.
- `bash scripts/file-level-review-expiry.sh` completed before final review.
- Production source files remain below the 500-line guardrail; the new resolver keeps Server Core
  scanning at 474 lines.

## Residual risk

- Server Core continues to treat a registry entry as installed even when its sensitive
  `.grok/config.toml` activation state is unavailable to the asset reader. This can expose an
  installed-but-disabled Plugin for inspection remotely, but it cannot reintroduce historical
  cache versions or expose configuration content.
- Claude and Codex tabs retain their adapter-native inventory policies; this fix changes only the
  Grok catalog that produced the reported cross-adapter duplication.

## Follow-ups

No follow-up is required for the reported duplicate-version defect.
