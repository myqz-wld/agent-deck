# CHANGELOG_323: Package commit build metadata

## Summary

Packaged Agent Deck builds now carry their source commit, and the terminal wrapper can compare the installed app with the current source checkout.

## Changes

- Added `scripts/write-build-info.mjs`, generating `build/build-info.json` from package metadata and git state.
- Wired `build-info.json` into Electron Builder `extraResources` and into all production packaging scripts.
- Added `agent-deck --version` and `agent-deck --check-installed` to the POSIX wrapper.
- Added matching Windows wrapper support through `agent-deck-version.ps1`.
- Documented the commit-based installed-package check in the README.

## Validation

- `node scripts/write-build-info.mjs`
- `bash -n resources/bin/agent-deck`
- `resources/bin/agent-deck --version`
- `resources/bin/agent-deck --check-installed` against the current old `/Applications` install returned exit `2` for missing build metadata.
- Temporary `.app` simulation with generated `build-info.json`: `AGENT_DECK_APP=<tmp app> resources/bin/agent-deck --check-installed` returned exit `0`.
- `pnpm typecheck`
- `pnpm build`
- `pnpm test` (178 files / 2016 tests)
- `pnpm exec electron-builder --mac dir`
- Verified `build/dist/mac-arm64/Agent Deck.app/Contents/Resources/build-info.json`.
- `AGENT_DECK_APP="build/dist/mac-arm64/Agent Deck.app" resources/bin/agent-deck --check-installed` returned exit `0`.
- `git diff --check`
