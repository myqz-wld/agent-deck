---
review_id: 169
reviewed_at: 2026-07-23
baseline_commit: 633b606e9621f5d910f6de33568be0bb5ca41399
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Lifecycle-record/index maintenance is mechanical archive work."
---

# REVIEW_169_grok-auth-asset-boundaries: Grok authentication and asset-edit boundaries

## Scope and method

This review traced Grok child launch and ACP authentication ordering, credential ownership,
application-convention persistence and injection, named Agent composition, adapter thinking
validation, IPC/preload exposure, Settings and Asset Library behavior, and reset boundaries.
Evidence combined direct diff inspection, deterministic fake-agent tests, the full repository
suite, two no-paid-model Grok smokes, and an isolated built Electron startup.

```review-scope
README.md
resources/README.md
src/main/__tests__/bundled-agent-runtime-validation.test.ts
src/main/adapters/__tests__/runtime-profiles.test.ts
src/main/adapters/grok-build/__tests__/acp-process.test.ts
src/main/adapters/grok-build/__tests__/fixtures/fake-grok-acp-agent.mjs
src/main/adapters/grok-build/__tests__/launch-child.test.ts
src/main/adapters/grok-build/__tests__/resources.test.ts
src/main/adapters/grok-build/__tests__/session-setup.test.ts
src/main/adapters/grok-build/acp-process.ts
src/main/adapters/grok-build/auth-probe.ts
src/main/adapters/grok-build/bridge.ts
src/main/adapters/grok-build/launch-child.ts
src/main/adapters/grok-build/resources.ts
src/main/adapters/grok-build/session-setup.ts
src/main/adapters/runtime-profiles.ts
src/main/agent-deck-mcp/__tests__/tools.test.ts
src/main/agent-deck-mcp/tools/schemas/spawn.ts
src/main/ipc/settings.ts
src/preload/api/misc.ts
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/SettingsDialog.test.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/assets/ApplicationConventionTab.test.tsx
src/renderer/components/assets/ApplicationConventionTab.tsx
src/renderer/components/assets/AssetCard.test.tsx
src/renderer/components/assets/AssetCard.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.test.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.tsx
src/renderer/components/assets/ProviderCombobox.tsx
src/renderer/components/settings/AdapterConfigHelp.tsx
src/renderer/components/settings/GrokAgentsMdEditor.test.tsx
src/renderer/components/settings/GrokAgentsMdEditor.tsx
src/renderer/components/settings/ResetSettingsButton.tsx
src/renderer/components/settings/__tests__/AdapterConfigHelp.test.tsx
src/renderer/components/settings/sections/AgentDeckMcpSection.tsx
src/renderer/components/settings/sections/GrokAuthenticationSection.tsx
src/renderer/components/settings/sections/__tests__/GrokAuthenticationSection.test.tsx
src/shared/ipc-channels.ts
src/shared/session-metadata.ts
src/shared/types/agent.ts
src/shared/types/settings/app-settings.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | The Grok bridge initialized ACP and immediately called `session/new` / `session/load`. A Dock-launched Agent Deck also inherited the GUI environment rather than variables exported by the user's shell, so native `env_key` authentication could fail even when terminal Grok worked. | Read `authMethods`, call `authenticate` before session operations, try API-key then cached-token methods, and launch the real Grok child through a supported login shell. Keep ACP JSON on fd 3 and never read, log, or persist API-key values. |
| MEDIUM | Grok application conventions and named Agents both occupied `_meta.agentProfile`; selecting `reviewer-grok` therefore omitted the editable app convention. | Move the baseline to native `_meta.rules` and keep the selected Agent in `_meta.agentProfile`. Unit and real CLI smokes prove both metadata fields are accepted together. |

## Validation evidence

- `pnpm typecheck` passed.
- `pnpm test` passed 349 files and 3,001 tests; one opt-in test remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- Fake ACP tests prove API-key preference, cached-token authentication, failure fallback, actionable
  interactive-only errors, and authentication-before-session ordering.
- Runtime/profile, MCP schema, and renderer tests cover Grok `xhigh`, built-in-only editing and
  reset behavior, app-styled Codex provider selection, Grok convention editing, the fourth
  Settings view, and no-prompt authentication diagnostics.
- Grok Build `0.2.110` authenticated with `cached_token` through the login-shell path without a
  model request. A separate smoke accepted `_meta.rules`, `reviewer-grok`, and the bundled plugin
  directory in one `session/new`; the generated session was deleted immediately afterward.
- An isolated built Electron instance initialized Claude, Deepseek, Codex, and Grok, mounted MCP,
  listened on 47831, displayed the renderer, and shut down cleanly. The installed instance on
  47821 remained running.
- Prompt inventory/backups, immutable counterpart hashes, local links, review expiry, and the
  500-line production guardrail passed.

## Residual risk and boundaries

- Login-shell inheritance can recover variables exported by shell startup files. A variable set
  only in one already-running terminal cannot propagate backward into a Dock-launched process;
  cached OAuth login or a persistent native Grok environment configuration remains the stable
  choice for that case.
- Interactive-only ACP methods are not driven from an invisible child process. The app reports the
  available method ids and directs the user to native `grok login --oauth`.
- The Settings probe proves initialize/authenticate only. It intentionally does not prove paid
  inference, model availability, or account quota.
- Arbitrary Grok custom model aliases and Codex provider ids remain provider-native free text.
  Agent Deck validates shape and adapter thinking levels, while the native CLI remains
  authoritative for model-specific support.

## Follow-ups

No unresolved material finding remains.
