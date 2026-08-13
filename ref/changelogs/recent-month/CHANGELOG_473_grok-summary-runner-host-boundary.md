---
changelog_id: 473
changed_at: 2026-08-05
---

# CHANGELOG_473_grok-summary-runner-host-boundary: Port Grok summary composition

## Summary

Periodic Grok summary execution no longer discovers desktop model, reasoning, binary, or timeout
settings from its Core path. The stable adapter runner now delegates to a Node-executable summary
Core through an explicit desktop settings host.

## Host-neutral summary runner

- Extracted event formatting, empty-input short-circuit, prompt construction, model/reasoning
  normalization, bounded Grok oneshot execution, and result cleanup into
  `summarizer-runner-core.ts`.
- Preserved zero host reads and zero provider work when both activity and evidence are empty.
- Kept per-session runtime model/reasoning ahead of desktop defaults while retaining desktop binary
  and timeout ownership for every actual invocation.

## Explicit desktop host and stable facade

- Moved the four provider summary setting reads into `summarizer-runner-host.ts`.
- Kept `summarizer-runner.ts` as the existing adapter-facing API.
- Imported the concrete Grok oneshot/prompt/result modules from Core instead of the broad oneshot
  barrel, preventing unrelated desktop diagnostic modules from entering the executable boundary.

## Executable boundary gate

- Added a direct-import rule rejecting the stable facade/desktop host, stores, runtime host,
  desktop utilities, Electron, and electron-log from Core.
- Added Grok summary execution as the thirty-eighth executable Node 22 boundary candidate.
- Added Core regressions for empty-input laziness and runtime precedence plus a desktop-host
  settings ownership regression.

## Validation

- Focused Core/host/public-runner coverage: passed, 3 files / 4 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty-eight Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 645 files / 4,843 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the Core runner, desktop host, stable facade, concrete oneshot imports, precedence/laziness
tests, direct-import rule, and bundle candidate together. Grok summary Core must not regain implicit
desktop settings or broad barrel imports that reintroduce desktop diagnostics.

## Remaining boundary

Grok periodic summary composition is now host driven. Codex summary and broader Claude/Grok runtime
paths still read desktop settings directly; Browser registry ownership and real
Linux/SSH/Feishu/provider acceptance remain outside this deterministic slice.
