# REVIEW_143

## Trigger Context

The user reported three related symptoms:

- `gpt-5.6-sol` was normalized to `gpt-5.6`.
- Codex sessions could show a concrete model while thinking remained `default`.
- Claude-side model/thinking metadata needed equivalent runtime calibration.

The user also requested confirmation that session model/thinking overrides do not affect global
sessions or provider configuration.

## Method

- Traced model values from MCP/adapter create options through Codex ThreadOptions and Claude query
  options into `sessions.model` / `sessions.thinking`.
- Compared local Codex 0.144 effort capabilities with installed Claude Agent SDK 0.3.205 types.
- Confirmed Claude exposes the authoritative main model on `system/init` and the active post-downgrade
  effort on Stop-family hook input.
- Reproduced the GPT normalization collision and inspected affected local rows read-only.
- Ran parallel normalization and runtime-metadata audits, then a separate read-only integration
  review of the combined Codex/Claude change.
- Exercised v036 with real SQLite under Electron's ABI rather than the Node skip path.

## Gate Result

PASS.

Severity distribution:

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 3 fixed
- LOW: 2 fixed defensively
- residual LOW risks: 2 documented

## Decision List

### MEDIUM fixed: GPT parser accepted a version prefix instead of a complete model id

Evidence: `src/shared/model-normalize.ts:116` previously matched the beginning of a GPT slug, so
`gpt-5.6-sol` was accepted as bare `gpt-5.6` before fallback could preserve the suffix.

Fix: require a full bare-version match and strip only approved terminal variants. v036 repairs
historical GPT buckets from `model_raw` while intentionally leaving Claude rows untouched.

### MEDIUM fixed: Codex global effort was effective at runtime but absent from session metadata

Evidence: `src/main/adapters/codex-cli/sdk-bridge/create-session/create-session-impl.ts:107` only
resolved an explicit value or a resumed row. A new session using top-level Codex config therefore
persisted `thinking = null` even when Codex ran a concrete effort.

Fix: resolve a safe new-session config hint and persist it on that session. Explicit/resumed values
remain real ThreadOptions overrides; config hints do not override Codex profile precedence. Resume
with a historical null remains null.

### MEDIUM fixed: Claude session metadata stayed at requested/default values

Evidence:

- `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts:262` had no init-model sync.
- There was no programmatic Stop/StopFailure observer for actual effort.

Fix: `system/init.model` updates the main model, and read-only Stop observers update the last observed
actual effort. Early observations survive in `internal.runtimeModel/runtimeEffort` until finalization.

### LOW fixed defensively: layered Codex config could make the display hint inaccurate

An active top-level profile or per-session `codexConfigOverrides.profile/model_reasoning_effort` can
override the base top-level effort. The reader now returns no hint for an active profile, the session
resolver suppresses hints when a per-session layer is present, and config hints never enter
ThreadOptions.

### LOW fixed defensively: shared Claude hook input includes an optional subagent id

Official SDK events use `SubagentStop` for subagents and `Stop` for the main agent. The observer only
registers Stop/StopFailure and additionally ignores any input carrying `agent_id`.

## Global-Scope Finding

Confirmed: model and thinking values are query/thread/session fields plus current-row DB metadata.
No implementation path added here writes global Codex/Claude configuration. A spawned session's
values affect that session and its later resume only.

## Residual Risks

- `getCodexConfigPath()` retains the repository's existing `~/.codex/config.toml` behavior. A custom
  `CODEX_HOME` can make the UI hint stay default or read the standard path, while Codex runtime still
  resolves its real config correctly.
- Claude can observe actual effort only on Stop/StopFailure. Interrupts, unsupported models, or hook
  frames without effort retain the requested/persisted value or default by design.
- v036 deliberately does not guess how historical custom Claude suffix buckets should be split; an
  installation with such old rows can temporarily contain old and new Claude bucket identities.

## Validation

- Full suite: 189 files / 2101 tests passed.
- Focused cross-adapter/config/MCP suite: 57 files / 563 tests passed.
- Real SQLite v036 suite: 3 files / 49 tests passed.
- Post-review guards: 3 files / 43 tests passed.
- `pnpm typecheck`, `pnpm build`, and `git diff --check` passed.

## Related Changelog

[CHANGELOG_347](../changelogs/CHANGELOG_347.md).
