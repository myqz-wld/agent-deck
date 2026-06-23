# CHANGELOG_324: Document packaged build metadata contract

## Summary

Project foundation docs now require installable Agent Deck packages to generate and ship build metadata, and to expose installed-version and freshness-check commands.

## Changes

- Added the build metadata and installed freshness contract to `CLAUDE.md` packaging rules.
- Added the same maintainer requirement to README packaging rules, without changing the lead's pending implementation.

## Validation

- `rg -n "build-info|check-installed|--version|installed metadata|freshness" CLAUDE.md README.md package.json scripts/write-build-info.mjs resources/bin/agent-deck resources/bin/agent-deck.cmd resources/bin/agent-deck-version.ps1 ref/changelogs/CHANGELOG_323.md ref/changelogs/CHANGELOG_324.md`
- Foundation structure check for root docs, `src/`, `scripts/`, `build/`, `ref/` indexes, and helper scripts.
- `bash -n resources/bin/agent-deck && bash -n scripts/file-level-review-expiry.sh && bash -n scripts/plan-archive-reminder-pre-commit.sh`
- `node scripts/write-build-info.mjs`
- `git diff --check`
- `git diff --check --no-index /dev/null ref/changelogs/CHANGELOG_324.md`

## Notes

- This is a documentation-only foundation repair. The build metadata implementation remains the lead's existing pending work in `CHANGELOG_323.md`.
