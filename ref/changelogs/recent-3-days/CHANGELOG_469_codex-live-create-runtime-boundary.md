---
changelog_id: 469
changed_at: 2026-08-05
---

# CHANGELOG_469_codex-live-create-runtime-boundary: Port create/resume runtime selection

## Summary

Ordinary Codex live-session create/resume runtime selection no longer reads the session repository,
desktop settings store, native config, or Agent Deck instructions from its Core policy. An explicit
desktop host captures the resume row and supplies lazy settings/config readers while preserving all
existing precedence and lifecycle ordering.

## Host-neutral live runtime policy

- Extracted provider, approval, sandbox, reasoning, developer-instruction, effective option, and
  native resume-thread selection into `runtime-selection.ts`.
- Kept explicit request values authoritative, then persisted resume values, then current host
  defaults; fresh-provider reuse still starts a new native thread while retaining session runtime
  choices.
- Preserved the distinction between a persisted reasoning hint and an explicit thread override, so
  current global config is not silently written into existing sessions.

## Explicit desktop repository host

- Added a two-phase host: capture the authoritative resume row once before Codex client acquisition,
  then resolve settings, native reasoning config, and application instructions after acquisition in
  the established order.
- Reused that captured row for sandbox, provider, approval, thinking, and native thread identity,
  retaining the existing single-read and reverse-rename invariants.
- Left create validation, token allocation, client ownership, start/resume choice, rollback, internal
  session construction, persistence, and enqueue dispatch unchanged.

## Executable boundary gate

- Added a direct-import rule rejecting the desktop runtime host, AGENTS facade, stores, runtime host,
  desktop logger, Node built-ins, Electron, and electron-log from the Core policy.
- Added live Codex create runtime selection as the thirty-fourth executable Node 22 candidate.
- Added Core regressions for resume inheritance, lazy defaults, fresh-provider reuse, and a desktop
  host regression for exact repository/settings/config/instruction composition.

## Validation

- Focused runtime policy/host, model passthrough, recovery, and teammate-default coverage: passed,
  5 files / 72 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed thirty-four Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 637 files / 4,830 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the Core policy, two-phase desktop host, single-row capture ordering, create orchestrator wiring,
precedence/recovery tests, direct-import rule, and bundle candidate together. Live create/resume must
not regain implicit settings, repository, native-config, or instruction discovery.

## Remaining boundary

Codex live create/resume runtime selection is now explicit. Provider client construction and several
Claude/Grok runtime paths still read desktop settings directly; Browser registry ownership and real
Linux/SSH/Feishu/provider acceptance also remain outside this deterministic slice.
