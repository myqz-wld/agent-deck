---
review_id: 172
reviewed_at: 2026-07-25
baseline_commit: dbea9c5e8713035393a2f533619250117fcf7b17
expired: false
---

# REVIEW_172_asset-library-cross-adapter-display: Asset discovery and card layout audit

## Scope and method

Reviewed the Assets Library card layout, Claude Code Plugin discovery and path resolution, shared
frontmatter parsing, and Grok asset-description rendering. Reproduced each reported symptom from
the current implementation, compared Claude Plugin discovery with the supported native layouts,
and added focused regression coverage before running the full repository validation suite.

```review-scope
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/assets/AssetCard.tsx
src/renderer/components/assets/AssetCard.test.tsx
src/main/claude-config/plugin-assets.ts
src/main/claude-config/plugin-assets.test.ts
src/main/plugin-assets.ts
src/main/user-assets.ts
src/main/user-assets.test.ts
src/main/utils/frontmatter.ts
src/main/utils/__tests__/frontmatter.test.ts
src/main/adapters/grok-build/__tests__/custom-assets.test.ts
```

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Long qualified names kept their flex min-content width, which widened the vertical scroller and produced a horizontal scrollbar with clipped card content. | Add `min-w-0`, explicit horizontal containment, wrapping, and bounded Plugin badges. |
| MEDIUM | Claude discovery only covered installed/plugin containers with default `agents/` and `skills/` directories, so skills-directory Plugins, root `SKILL.md`, and manifest-declared component paths were absent. | Merge installed, plugin-container, and `~/.claude/skills` roots; scan root/default/custom components; keep direct Skills from duplicating Plugin roots. |
| LOW | The shared frontmatter parser returned YAML block markers such as `>` or `>-` as the description and ignored the indented text used by some Grok assets. | Parse folded and literal block scalar values while preserving the existing quoted/bare scalar behavior. |

## Evidence and validation

- Targeted Assets Library, Claude Plugin, frontmatter, user-assets, and Grok tests passed: 5 files,
  33 tests.
- `pnpm typecheck` passed.
- `pnpm test` passed: 365 files passed, 1 skipped; 3,089 tests passed, 1 skipped.
- `pnpm build` passed.
- `git diff --check` passed.
- `bash scripts/file-level-review-expiry.sh` completed before final review.

## Residual risk and boundaries

- The Assets Library remains intentionally limited to Agents and Skills; command-only Claude
  Plugins do not gain a new asset kind in this fix.
- The lightweight frontmatter parser supports the common `>` / `|` block forms needed for asset
  metadata but still does not implement full YAML collections, anchors, or explicit indentation.

## Follow-ups

No unresolved in-scope finding remains.
