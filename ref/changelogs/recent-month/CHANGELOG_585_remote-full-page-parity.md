---
changelog_id: 585
changed_at: 2026-08-10
---

# CHANGELOG_585_remote-full-page-parity: Align Remote with the Local workspace

## Summary

Remote/Relay now exposes the same capability-backed workspace structure and shared interaction
surfaces as Local instead of a reduced three-page shell. Teams, Issues, Data, session creation,
session summaries, History, and provider pending interactions use authoritative Core contracts and
the same presentation components where their semantics match.

## Changes

- Replaced the hard-coded Remote page trio with a shared capability-gated view catalog.
- Added bounded Remote Team and Usage contracts, Server Core runtimes, Main IPC/service validation,
  preload APIs, source-isolated data hooks, and shared Team/Data components.
- Unified provider/model/thinking and adapter-owned creation controls through one option catalog:
  Claude permission/sandbox, Codex approval/sandbox, and Grok session/sandbox fields keep their
  native meanings and incompatible values are rejected.
- Reused shared session status/summary, AskUserQuestion, Permission, native ExitPlan, MCP plan, and
  diff presentations with exact Remote response binding.
- Added Remote History filtering, authoritative Core day/usage views, capability growth fencing,
  and profile/Core-generation/source isolation.
- Advanced the protocol to 2.1 and minor-gated the new Usage advertisement so older 2.0 desktops
  continue connecting.
- Added bounded permission previews that retain material file/diff/MCP context, conservatively
  redact named secrets, and disable approval when the authorization scope cannot be shown safely.
- Restored uncertain pending-response replay and Team mutation idempotency.

## Validation

- `pnpm test` — 876 files / 5,704 tests passed; 2 files / 3 tests skipped.
- `pnpm typecheck`
- `pnpm build`
- `pnpm verify:linux-headless`
- `pnpm verify:macos-worker-sandbox`
- Official Electron runtime-composition suite — 5/5 passed.
- Paired Claude/Codex deep review and two post-fix convergence passes.
- `git diff --check` and changed-file 500-line checks.

## Acceptance boundary

This record establishes source and package readiness. The managed Relay and isolated macOS Worker
must be upgraded from the clean pushed commit through the official deployment scripts. Real Remote
Claude/DeepSeek and Codex sessions remain required before production acceptance.

## Do Not Split Protection

The view catalog, option catalog, Team/Usage contracts and runtimes, data-source adapters,
permission preview, and pending authority form one compatibility boundary. Splitting them would
permit UI controls without Core authority, or Core methods without source-isolated presentation.
