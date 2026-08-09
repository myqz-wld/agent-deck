---
changelog_id: 513
changed_at: 2026-08-05
---

# CHANGELOG_513_claude-sdk-message-translate-core-boundary: Publish Claude message translation Core

## Summary

The complete Claude SDK message dispatcher is now an independently executable, host-neutral Core.
The stable desktop facade preserves every existing call site while injecting identity, clock,
runtime metadata, live-rate observation, and translation-state ownership through one aggregate host.

## Complete message translation Core

- Moved the full SDK message dispatcher into `sdk-message-translate-core.ts`, covering init/status,
  assistant/user/stream/result frames, context and token usage, tool lifecycle, file changes, compact
  outcomes, expected-close suppression, and user-message acceptance.
- Replaced concrete desktop constants, runtime synchronization, live-rate observation, repository,
  and event-bus dependencies with `ClaudeSdkMessageTranslationHost` ports.
- Kept the already extracted runtime metadata, live rate, final usage, context attribution,
  translation state, and file-change Cores as direct dependencies rather than routing Core through
  desktop facades.

## Stable desktop facade and compatibility

- Reduced `sdk-message-translate.ts` to a 38-line injection facade using `AGENT_ID`, `Date.now`, and
  the three concrete desktop hosts.
- Preserved the existing `translateSdkMessage` signature and the public
  `pushFileChangeIntent`/`consumePendingFileChangeIntent` exports.
- Preserved expected-close semantics: terminal result frames remain completely silent while the
  live token-rate estimate is still retired exactly once.

## Direct evidence and executable gate

- Added direct Core tests proving injected identity/clock use, separate init model and permission
  persistence ports, and expected-close terminal cleanup.
- Retained token/reasoning/compact/status/init/file-change/stream retirement suites as facade and
  behavior integration evidence.
- Added a direct-import rule rejecting the desktop translator and host facades, desktop state,
  Node built-ins, Electron, and electron-log, plus the seventy-eighth executable Node 22 candidate.

## Validation

- Focused Core/translator integration coverage: passed, 8 files / 52 tests.
- `mise exec -- pnpm typecheck`: passed; the architecture gate executed seventy-eight Node 22 bundle
  candidates.
- `mise exec -- pnpm build`: passed.
- Canonical Electron full suite: passed, 714 files / 4,984 tests plus 1 skipped.
- No shared development or Electron process was started, restarted, stopped, or killed.

## Do Not Split Protection

Keep the aggregate Core host, stable desktop facade, extracted sub-Cores, architecture rule, and
direct plus integration tests together. The Core must not regain desktop repositories/event buses,
and expected-close results must not leak user-visible terminal output while retiring live-rate state.

## Remaining boundary

Claude message translation is now executable-gated end to end. Stream-processor/provider session
composition and remaining concrete Core provider settings/repository ownership are the next code
seams, followed separately by real Linux/SSH/Feishu/provider acceptance.
