---
review_id: 253
reviewed_at: 2026-08-18
baseline_commit: 76e2b6471db034367d9d1686659c2545fbb0871f
expired: false
---

# REVIEW_253_current-only-gap-sweep: Remaining-area and prompt/UI contract review

## Scope and policy

This follow-up covers the areas explicitly left read-only or without a dedicated worker in
REVIEW_252. Two editing workers scanned utilities/tests and exact root configuration files, while a
third worker performed a mechanically read-only Prompt Asset Improver audit. The lead verified each
diff, obtained separate user authorization for all seven proposed prompt assets, created and checked
the required backups, applied paired edits, implemented the user's settings-copy follow-up, and ran
the integrated repository validation.

The current-only policy remains unchanged: delete only unsupported historical scaffolding and
zero-consumer configuration; preserve live provider, platform, recovery, security, and operator
contracts. Prompt text must describe the live tool schema instead of assuming one topology.

```review-scope
CLAUDE.md
README.md
electron.vite.config.ts
package.json
pnpm-lock.yaml
resources/README.md
resources/claude-config/CLAUDE.md
resources/codex-config/CODEX_AGENTS.md
resources/grok-config/GROK_AGENTS.md
resources/grok-config/agent-deck-plugin/skills/hello-from-deck/SKILL.md
src/main/utils/__tests__/git-branch.test.ts
src/renderer/components/SettingsDialog.test.tsx
src/renderer/components/settings/sections/ExperimentalSection.tsx
src/renderer/components/settings/sections/LogsSection.tsx
src/renderer/components/settings/sections/__tests__/LogsSection.test.tsx
tsconfig.node.json
vitest-setup.ts
vitest.config.ts
```

PLAN_40/REVIEW_252 implementation paths and mechanical record bucket moves remain outside this
follow-up scope.

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Root dependencies still declared `@electron-toolkit/preload` with no static/dynamic import, script, bundler, or preload consumer; distribution commands duplicated the build and build-info stages. | Remove the dependency and its three lock sections, make `pnpm build` the canonical stage used by all distributions, and retain current peer/toolchain dependencies with producer evidence. |
| MEDIUM | Shared bundled conventions described Desktop-only optional fields, absolute worktree paths, local `/tmp` handoff files, and a Codex Browser-only route even though the same assets run in Server Core sessions. | Route optional fields and path domains through the live schema, state the Core Workspace ceiling, require successor-readable context paths, and document Desktop Browser plugin versus Server Core `browser_*` tools. |
| LOW | `git-branch.test.ts` mocked and asserted a logger that the production utility no longer imports or calls. | Delete the mock, setup, aggregation helper, and silence assertions while preserving exact subprocess, null, and error behavior tests. |
| LOW | Root/resource docs retained historical negative comparisons and Grok's self-check metadata omitted plugin/skill-chain and Chinese trigger parity. | Replace historical prose with positive current Gateway/collaboration/navigation contracts and update only Grok hello frontmatter; manifests, reviewer bodies, and review skills remain unchanged. |
| LOW | Sandbox help mixed duplicated prose, adapter-specific formatting, and an unsupported Grok macOS limitation; the log panel duplicated platform paths despite an open-directory action. | Render each current option label/title through one shared layout, retain real Grok custom-profile/session behavior, remove the macOS sentence, and keep only retention plus the directory action. |

## Fixes landed

- Changed 18 follow-up files: 135 insertions and 165 deletions, net 30 lines removed.
- Removed one unused production dependency and stale lock records without changing the package
  manager, Node version, native-build policy, platform matrix, or current peer pins.
- Replaced root/test configuration duplication and historical comments with current executable
  ownership.
- Updated seven confirmed prompt assets after a read-only counterpart audit and hash-verified backup.
- Unified settings copy without changing sandbox enum values, defaults, runtime semantics, or log
  operations.

## Prompt Asset Improver evidence

- User Custom Points: the active 2026-06-09 `resources/` point forbids migrated asset names and
  maintenance-format prose in reusable runtime assets.
- Scope confirmation: the audit covered 22 exact assets; the later proposed-change request named the
  seven editable files and sections. The user replied `go on`, authorizing all seven.
- Inventory freshness: `.prompt-asset-improver/local/inventory.json` was refreshed at
  `2026-08-18T07:02:08Z`, expires after seven days, and matches 22/22 current hashes.
- Backup: `.prompt-asset-improver/local/backups/20260818T065723Z/manifest.json` is valid; all seven
  backup files match their recorded original SHA-256 values. Restore by copying each manifest
  `backup_path` to `original_path`.
- Preserved differences: Claude native Desktop-local worktrees and SDK loading, Codex native child
  agents/Gateway/approval plus dual Browser routing, and Grok ACP/session-load/custom sandbox behavior.
- Unchanged check-only assets: AGENTS/UI language policy, both plugin manifests, all reviewers, all
  deep/simple review skills, and Claude/Codex hello skills.

## Validation and evidence

- `pnpm typecheck`: passed architecture, Core/Node boundary, Node TypeScript, and Web TypeScript.
- `pnpm test`: 971 files / 6,135 tests passed; 2 files / 3 explicit live/platform tests skipped.
- `pnpm build`: passed main, preload, renderer, and build-info generation.
- `pnpm check:deployment`: passed.
- `pnpm logger:check`: passed with zero `console.*` residue.
- Utilities/main focused suite: 19 files / 161 tests passed.
- Prompt contract suite: 3 files / 18 tests passed; links, frontmatter, resource paths, paired
  behavior, 22/22 inventory hashes, and 7/7 backup hashes passed.
- Settings follow-up: 3 files / 22 tests and Web TypeScript passed; assertions cover current Grok
  modes, removal of the unsupported macOS note, retained log retention, and absence of platform paths.
- Package/lock frozen offline validation, Electron Vite renderer resolution, root build, deployment,
  scoped/full `git diff --check`, and the 500-line guard passed.

## Residual risk and follow-up

- The existing `node_modules` may retain the removed preload package link until the next normal
  `pnpm install`; the manifest and frozen lock are already consistent and no build/test imports it.
- The live Electron process was not restarted because it owns this delivery session. Renderer copy
  may hot-reload; all main-process and packaged-resource changes are guaranteed on the next normal
  launch.
- No Docker-backed Feishu runtime artifact was rebuilt; this follow-up did not change its runtime
  artifacts, and the full tests plus deployment checks passed.
- No compatibility or cleanup follow-up remains from the scanned areas.
