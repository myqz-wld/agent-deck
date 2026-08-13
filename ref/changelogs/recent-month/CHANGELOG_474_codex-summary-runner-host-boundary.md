---
changelog_id: 474
changed_at: 2026-08-05
---

# CHANGELOG_474_codex-summary-runner-host-boundary: Port Codex summary policy

## Summary

Periodic Codex summary policy no longer discovers desktop model, reasoning, or timeout settings and
no longer constructs its app-server execution path from Core. The stable adapter runner now uses an
explicit desktop settings/execution host.

## Host-neutral summary policy

- Extracted empty-input short-circuiting, prompt construction, model/reasoning/provider precedence,
  timeout binding, and compact-result cleanup into `summarizer-runner-core.ts`.
- Preserved zero host reads and zero provider execution when both formatted activity and evidence
  are empty.
- Kept per-session runtime model, reasoning, and provider identity ahead of desktop summary
  defaults.

## Explicit desktop host and stable facade

- Moved summary setting reads and the hardened `runCodexOneshot` execution port into
  `summarizer-runner-host.ts`.
- Kept `summarizer-runner.ts` as the existing adapter-facing API.
- Left the app-server instance pool, isolated temporary cwd, cancellation, sandbox, and process
  lifecycle owned by the existing desktop oneshot runner instead of pulling them into summary Core.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade/desktop host, Codex oneshot process runner,
  stores, runtime host, desktop utilities, Node built-ins, Electron, and electron-log from Core.
- Added Codex summary policy as the thirty-ninth executable Node 22 boundary candidate.
- Added Core regressions for empty-input laziness and runtime precedence plus a desktop-host
  settings/execution ownership regression.

## Validation

- Focused Core/host/model/oneshot coverage: passed, 3 files / 20 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty-nine Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 647 files / 4,846 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the Core policy, desktop settings/execution host, stable facade, laziness/precedence tests,
direct-import rule, and bundle candidate together. Summary Core must not regain implicit desktop
settings or app-server process composition.

## Remaining boundary

Codex periodic summary policy is now host driven. Broader Claude/Codex/Grok live runtime paths still
read desktop settings directly; Browser registry ownership and real Linux/SSH/Feishu/provider
acceptance remain outside this deterministic slice.
