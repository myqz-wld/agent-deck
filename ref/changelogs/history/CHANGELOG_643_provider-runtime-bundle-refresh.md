---
changelog_id: 643
changed_at: 2026-09-15
---

# Provider Runtime Bundle Refresh

## Summary

Refresh the Claude, Codex, and Grok dependencies and prepare the macOS arm64 application with
matching embedded application and Worker runtimes.

## Changes

- Upgrade `@anthropic-ai/claude-agent-sdk` from `0.3.260` to `0.3.272`, including its eight
  platform packages and Claude Code `2.1.272` executable.
- Upgrade `@anthropic-ai/sdk` from `0.123.0` to `0.125.0`.
- Upgrade `@openai/codex` from `0.153.4` to `0.154.0`, including all six native platform aliases.
- Upgrade `@xai-official/grok` from `1.0.13` to `1.0.30`, including all six platform packages.
- Keep ACP `1.4.0`, MCP `1.30.0`, and unrelated dependencies at their existing versions. The
  selected versions match the official npm stable tags checked for this refresh.
- Document the bundled versions and rebuild/reinstall requirement in the README Quick Start
  section. Correct the resource documentation to describe Grok's existing bundled-runtime default
  and explicit external executable override.
- Rebucket 56 existing changelogs by their recorded dates, move the associated model-routing
  validation evidence, and update affected indexes and the referencing plan path.

## Validation

- Official npm version tags, engine constraints, peer dependencies, platform packages, and archive
  integrity checked. The Claude arm64 archive was verified against its published SHA-512 before
  importing it into the pnpm store; the lockfile contains standard registry integrity references.
- Scoped pnpm dependency update and `pnpm install --frozen-lockfile --offline --ignore-scripts`
  passed without unrelated dependency changes.
- Claude Agent SDK, Anthropic SDK, and ACP import checks passed.
- Native version checks returned Claude Code `2.1.272`, Codex CLI `0.154.0`, and Grok `1.0.30`.
- Real Codex app-server and Grok ACP initialization accepted the application's initialization
  payloads using isolated temporary configuration directories and exited cleanly after stdin
  closed. No authenticated model request was needed.
- `pnpm typecheck` passed, including architecture checks.
- `pnpm test`: 1,027 files and 6,363 tests passed; 2 files and 3 opt-in tests skipped. The SQLite
  binding hash remained unchanged after both testing and packaging.
- `pnpm verify:bundled-runtimes` passed, including the Grok remote sandbox canary.
- `pnpm dist:mac` passed, including the production build and source/packaged macOS Worker sandbox
  checks. The app, DMG, and block map are available under `build/dist/`.
- ASAR inspection confirmed all four updated package versions. All six application/Worker
  executable checks returned the expected Claude, Codex, and Grok versions.
- README local links, original backup hashes, refreshed prompt-asset inventory hashes, changelog
  index routing, and `git diff --check` passed.

## Do Not Split Protection

No production source files changed. The generated dependency lockfile is exempt from the file-size
guardrail.

## Notes

- The user deferred installation and requested commit and push. The running installed application
  remains unchanged; a later installation requires approval under Host Runtime Safety. Worker
  executables were signed and verified during packaging; the normal local installer performs the
  application-level ad-hoc signing step. No Developer ID certificate is configured for this build.
- User Custom Points: none. The dependency refresh request and required matching documentation
  authorize the scoped README synchronization. Only `README.md` and `resources/README.md` changed;
  paired Claude/Codex application conventions were inspected and retain their existing semantics.
  The local inventory was refreshed with a seven-day expiry, the README files were backed up, and
  original/final hashes and local links were validated. Local backup/inventory records are retained;
  transient download and validation workspace files are scratch material.
- Official sources: [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
  [Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk),
  [Codex release notes](https://developers.openai.com/codex/changelog), and
  [Grok](https://www.npmjs.com/package/@xai-official/grok).
