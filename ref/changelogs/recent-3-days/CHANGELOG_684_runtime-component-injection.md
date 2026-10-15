---
changelog_id: 684
changed_at: 2026-10-15
---

# Session component injection and explicit refresh

## Summary

Bundled components now use immutable, session-selected asset versions. Settings continue to apply
to new sessions by default; `/deck-refresh` explicitly refreshes native-supported components in the
current session at a provider-owned idle boundary. The header Pending controls now align vertically.

## Changes

- Decouple shared MCP definitions and policy filtering from the Claude SDK runtime. Preserve all
  20 public tool contracts, schemas, descriptions, annotations, permissions, and handler dispatch.
- Publish transformed asset trees under content hashes, validate before reuse, and persist current
  and historical selections. Desktop, Relay Worker, and Server Core use their owning-host paths.
  Claude reloads use a private stable view per session; cache holds restore its previous files.
- Keep old paths when switches are disabled or bundled content changes, including closed resumable
  sessions. Permanent history deletion releases references. Collect unreferenced versions at the
  next owning-host startup, before providers begin; unknown legacy references are retained.
- Reserve input before checking provider idle state. Wait for active turns, native background work,
  tools, and approvals; preserve message order. Merge duplicate requests and keep queued cancellation
  separate from model interruption. Close, handoff, cwd/runtime replacement, and model changes
  invalidate queued refreshes. Runtime-setting changes cannot overlap native refresh application.
- Route exact standalone `/deck-refresh` and `/deck-refresh cancel` through typed local IPC and
  remote Core control actions, using existing slash completion. Messages, quoted commands, tool
  output, and cross-session messages do not acquire control authority. Invalid input retains its
  text/attachments. Feedback uses application/system events and creates no model turn.
- Append the Core method to the compact authorization directory and advance policy revision to 2.
  Decode preceding shorter grants without shifting existing permissions or granting the new method.
- Keep README to a short usage paragraph, per the owner's final instruction. Implementation details
  and evidence live in this record and the related plan/review.

## Native refresh boundaries

| Provider | Applied only with native evidence | Remains new-session-only |
| --- | --- | --- |
| Claude | App MCP add/remove/reconnect; already loaded plugin-root rescanning and Skills rereading; native cache-impact holds preserve the old view | An absent startup plugin root; fixed application instructions |
| Codex | Extra-root replacement including an empty set, followed by forced Skills inventory verification | Injected MCP overrides, plugin resolver changes, fixed application instructions |
| Grok | Session-scoped MCP replacement plus target-session inventory verification, with bounded unsupported-method fallback | Skills/plugin broadcasts affecting other resident sessions; fixed application instructions |

The Grok boundary corrects the initial planning assumption after inspecting the local native source.
No provider process is rebuilt automatically. A prepared disk asset or successful connectivity check
is not a loaded-session confirmation. Results report updated, unchanged, new-session-required,
cache-deferred, or failed components independently.

## Discovery and dependency decisions

Native Tool Search defaults and explicit user settings remain intact. No retired Codex switches or
unverified Gateway requirement were introduced. The full serialized tool contracts are unchanged;
input/cache-token savings and first-tool latency are unmeasured. Diagnostics report observed native
inventory counts and, where available, catalog characters, while activation remains explicitly unknown.

Claude `/core` was assessed but not substituted for the shared root loader: the existing history and
fork consumers require exports absent from `/core`. Removing the generic MCP loader call provides
the supported dependency separation. No package or lockfile update was necessary.

## Validation

- `pnpm typecheck`: passed architecture boundaries and both TypeScript projects.
- `pnpm test`: 1,181 files and 7,417 tests passed; 3 files / 6 opt-in tests skipped.
- `pnpm build`: passed for main, preload, renderer, and build metadata.
- Three pre-change wire-catalog fingerprints match with the Claude loader unavailable. Existing
  handler and transport regressions continue to pass.
- Deterministic fixtures cover immutable publication/reuse/failure, disabled injection, historical
  ownership/rename/deletion, plugin view recovery, queued cancellation, background consumers,
  runtime identity, cache holds, partial native failure, unsupported Grok extensions, exact host
  targeting, command interception, and legacy authorization decoding.
- Browser inspection rendered the actual AppHeader in four active/inactive and badge/empty states.
  Adjacent visible controls have identical top coordinates and 16.25 CSS-pixel height in the fixture.
  The private fixture and Browser tab were removed after inspection.
- The Electron SQLite binary SHA-256 remained
  `463d208825f4d2660f4ec14181563c4b2ddbfeb779584c9b3251f0d7aafb2c67`.
  Validation used the existing dependencies and Electron-as-Node test runner, without installation
  or rebuilding shared native dependencies.

## Do Not Split Protection

None required. Changed production source files are at most 500 lines. Extracted runtime refresh,
asset ownership, native consumer tracking, and current-turn helpers keep provider facades bounded.

## Activation and related records

Source and validation were completed in the isolated worktree. The owner subsequently authorized
merge to main, structured worktree cleanup, and push. The running application and installed bundle
are unchanged. Activation requires applying this build to the intended Desktop/Worker/Core
host and restarting that target under a separate explicit authorization. No installation, restart,
deployment, live provider session probe, or paid model call occurred.

- [Approved plan](../../plans/recent-3-days/PLAN_95_runtime-component-injection.md)
- [Implementation audit](../../reviews/recent-3-days/REVIEW_329_runtime-component-boundaries.md)
