---
review_id: 174
reviewed_at: 2026-07-26
baseline_commit: a186fa53d4dcf1fd24bb97788101f871acaea0a3
expired: false
---

# REVIEW_174_grok-custom-assets-test-isolation: Grok custom-assets test isolation audit

## Scope and method

Reproduced the reported failure on a developer machine with live Claude Plugins, traced the extra
assets to the intentional `homedir()/.claude/plugins` production search root, and isolated that
root in the test lifecycle without weakening the folded-description assertion.

```review-scope
src/main/adapters/grok-build/__tests__/custom-assets.test.ts
```

## Findings and fixes

| Severity | Finding | Resolution |
|---|---|---|
| LOW | The suite replaced `GROK_HOME` but left `HOME` unchanged, so every asset-listing call could scan the developer's live Claude Plugins. The exact folded-description assertion therefore received 47 unrelated skills in addition to its fixture. | Give each test a temporary user home through `HOME`, restore the original environment after each test, and remove the temporary directory during cleanup. |

## Evidence and validation

- Before the fix, the focused file failed 1 of 5 tests and returned 48 skills: the fixture plus 47
  assets under the live `~/.claude/plugins`.
- After the fix,
  `pnpm exec vitest run src/main/adapters/grok-build/__tests__/custom-assets.test.ts` passed all 5
  tests while preserving exact-array equality.
- `pnpm typecheck` passed.
- The full `pnpm test` run passed the fixed custom-assets file and reported 365 passing files,
  1 skipped file, and 3,093 passing tests. The command remained non-green only because the local
  install lacks the unrelated optional native package `@xai-official/grok-darwin-arm64`; its
  `resolve-grok-binary.test.ts` failure predates and does not exercise this review scope.
- `git diff --check` passed, and all dated review records remain in their correct time buckets.
- `bash scripts/file-level-review-expiry.sh` completed before final review.

## Fixes landed

- Isolated the Grok asset tests from both the configured Grok home and the operating-system user
  home.
- Preserved production Claude Plugin discovery and the strict folded-description regression
  assertion.

## Residual risk and boundaries

No unresolved in-scope finding remains. The missing local Grok native package is an installation
state issue outside this test-isolation fix.

## Follow-ups

No in-scope follow-up is required.
