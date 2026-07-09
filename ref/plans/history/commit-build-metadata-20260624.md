# Commit Build Metadata Plan

## Status

Completed on 2026-06-24.

## Goal

Let an installed Agent Deck package reveal the commit it was built from and let the wrapper compare that commit with the current `agent-deck` source checkout.

## Scope

- Generate `build/build-info.json` during build and packaging.
- Include that file in packaged app resources.
- Add wrapper commands for human-readable version output and machine-readable installed-package checks.
- Document the command contract and archive the functional change.

## Decisions

- Commit equality is the freshness check. Dirty flags are shown as context, but they do not replace commit comparison.
- `--version` is informational and exits `0`; `--check-installed` exits non-zero when packaged metadata is missing or the commit differs.
- The wrapper compares against local git refs only. It does not fetch remote refs.

## Validation

See [CHANGELOG_323](../../changelogs/history/CHANGELOG_323.md).
