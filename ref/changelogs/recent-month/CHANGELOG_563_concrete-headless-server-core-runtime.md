---
changelog_id: 563
changed_at: 2026-08-05
---

# CHANGELOG_563_concrete-headless-server-core-runtime: Package the concrete headless Server Core

## Summary

The Full Linux topology now ships one concrete Electron-free Server Core runtime. It owns the
session/event repositories, provider registry, Claude/Codex/Grok adapters, session-console
authority, metadata publication, and live credential lifecycle behind the existing injected
runtime bootstrap.

## Concrete runtime composition

- Added exact runtime-option parsing for the project catalog and provider settings; unknown root
  fields fail closed.
- Constructed the real repository host, metadata store, provider adapter set, adapter registry,
  daemon runtime, and session-console authority without importing desktop singleton indexes.
- Added fixed headless provider hosts for Claude, Codex, and Grok. Their executables resolve only
  from `/opt/agent-deck/providers/<provider>/...`; the headless runtime does not enable Browser,
  desktop MCP, worktree, or handoff fallbacks.
- Added bounded provider retirement and reverse-order repository/metadata/provider lifecycle
  cleanup with aggregate failure reporting.
- Preserved Codex live-session/MCP-token rename handling and the Claude restart rename bus.

## Credential lifecycle

- Added a private exact-schema credential authority at
  `/run/secrets/agent-deck/credentials.json` with canonical-file, owner, mode, size, instance,
  credential, surface, and status validation.
- Pull checks run at hello/request/subscription boundaries; a bounded poller publishes exact
  credential-and-surface revocations to the daemon connection registry.
- Removed or revoked records close only matching live connections. Unreadable or invalid updates
  fail closed without reflecting file paths or raw parse errors.

## Linux artifact contract

- Added `server-core-runtime` as the seventh isolated Linux headless role and installed its bundle
  at `/opt/agent-deck/linux-headless/server-core-runtime/index.mjs`.
- Locked the Claude, Codex, and Grok provider executable paths in the manager package manifest and
  hardened `agent-deckd` ownership, symlink, mode, and executable checks for every parent and file.
- Updated the Full config, credential fixture, README, and static gate to pin the runtime module,
  private credential authority, exact surfaces, and provider executable layout.
- The fresh built bundle is imported under Electron-as-Node, constructs the real bootstrap, and is
  checked for role isolation, fixed paths, exact credential input, and allowed external imports.

## Enforced boundary

- Added the concrete runtime as an explicit architecture rule and as the 121st executable Node 22
  boundary candidate.
- The runtime may not import desktop provider/runtime registries, provider singleton indexes,
  Browser, the desktop event bus, renderer code, Electron, or electron-log.

## Validation

- Focused Server Core/provider composition coverage passed: 14 files / 90 tests.
- TypeScript and architecture checks passed with 121 executable candidates.
- Production build passed with 799 main modules.
- Seven-role `verify:linux-headless` and Full/Relay/Manager/Feishu static and shell checks passed.
- Canonical Electron full suite passed: 761 files plus 1 skipped / 5120 tests plus 1 skipped.
- Logger, diff, tracked/untracked whitespace, ordinary-source 499-line ceiling, and cached-index
  checks passed. No shared development or Electron process was stopped, restarted, or signalled.

## Do Not Split Protection

Keep the concrete runtime composition, private credential lifecycle, fixed provider executable
layout, seventh-role package mapping, fresh-bundle import gate, and Full deployment fixtures in one
release slice. Splitting them would allow a source-level runtime to pass while its delivered wrapper,
credential authority, or provider binaries no longer match.

## Evidence boundary

This is deterministic source, unit/integration, production-build, and artifact evidence on macOS.
Real Ubuntu/EL9, systemd-user, rootless Podman, sshd forced-command, target-ABI native module, live
Feishu, and live Claude/Codex/Grok provider acceptance remain unclaimed.
