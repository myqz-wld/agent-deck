---
review_id: 168
reviewed_at: 2026-07-23
baseline_commit: b5a7725190b29556aeff9f326ba8feb0a20a8f11
expired: false
skipped_expired:
  - file: "ref/**"
    reason: "Lifecycle-record/index maintenance is mechanical archive work."
---

# REVIEW_168_bundled-agent-runtime-overrides: Bundled Agent override boundaries

## Scope and method

This review traced the built-in/user asset boundary, validation and persistence, reset semantics,
Codex native-provider discovery, adapter-specific runtime application, explicit spawn precedence,
renderer behavior, and approved prompt/document changes. Evidence combined direct diff inspection,
targeted regression tests, the full repository suite, prompt-asset validation, and an isolated
Electron startup.

```review-scope
README.md
resources/README.md
resources/grok-config/agent-deck-plugin/agents/reviewer-grok.md
src/main/__tests__/bundled-assets-multi-root.test.ts
src/main/__tests__/bundled-agent-runtime-overrides.test.ts
src/main/__tests__/bundled-agent-runtime-validation.test.ts
src/main/agent-deck-mcp/__tests__/spawn-agent-name-routing.test.ts
src/main/agent-deck-mcp/__tests__/spawn-agent-resolver-grok.test.ts
src/main/agent-deck-mcp/__tests__/spawn-agent-runtime-overrides.test.ts
src/main/agent-deck-mcp/__tests__/spawn-model-options-grok.test.ts
src/main/agent-deck-mcp/tools/handlers/spawn-agent-resolver.ts
src/main/agent-deck-mcp/tools/handlers/spawn-model-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn-target-options.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/bundled-agent-runtime-overrides.ts
src/main/bundled-agent-runtime-validation.ts
src/main/bundled-assets.ts
src/main/codex-config/__tests__/model-providers.test.ts
src/main/codex-config/model-providers.ts
src/main/codex-config/toml-writer.ts
src/main/ipc/assets.ts
src/main/ipc/settings.ts
src/preload/api/misc.ts
src/renderer/components/AssetsLibraryDialog.tsx
src/renderer/components/assets/AssetCard.test.tsx
src/renderer/components/assets/AssetCard.tsx
src/renderer/components/assets/AssetsTab.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.test.tsx
src/renderer/components/assets/BundledAgentRuntimeEditor.tsx
src/shared/ipc-channels.ts
src/shared/types/assets.ts
src/shared/types/settings/app-settings.ts
src/shared/types/settings/defaults.ts
```

## Findings and resolutions

| Severity | Finding | Resolution |
|---|---|---|
| MEDIUM | Claude SDK `AgentDefinition.model` and `effort` can override the outer spawn options. Applying an explicit spawn model/thinking only at the outer layer therefore did not guarantee the documented precedence for a bundled Agent. | Synchronize the final resolved model and effort into the active bundled `AgentDefinition` as well as the outer options; added a regression proving explicit `sonnet` / `high` wins over packaged `opus` / `xhigh`. |
| LOW | Clearing a packaged Codex provider produced no stored provider delta, so the packaged value silently reappeared after refresh and made the save look successful. | Reject a blank provider when the packaged Agent has a provider and direct the user to select the packaged default or use Restore Default. |

## Validation evidence

- `pnpm typecheck` passed.
- `pnpm test` passed 342 files and 2,986 tests; one opt-in test remained skipped.
- `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- Backend tests cover strict validation, malformed persisted state, complete-record reset, raw/effective
  asset separation, Codex provider parsing, and bundled-only runtime application.
- Runtime tests cover Claude/Deepseek, Codex, and Grok packaged defaults, app overrides, explicit
  override precedence, and rejection of user/project Agent leakage.
- Renderer tests cover save, provider clearing, Restore Default, and built-in-only controls.
- `grok plugin validate` accepted the unchanged plugin structure with the updated reviewer model.
- Prompt backup manifests, editable-asset hashes, check-only counterpart hashes, and local
  documentation links matched.
- Review-expiry and changed-source file-size checks passed.
- An isolated development instance initialized all four adapters, mounted MCP, listened on an
  alternate hook port, showed the renderer window through `ready-to-show`, and shut down cleanly.

## Residual risk and boundaries

- Native provider ids are intentionally not validated against the current suggestions because
  Codex accepts custom provider ids and the native configuration may change outside Agent Deck.
  Invalid ids fail in the native adapter with its normal error.
- The app does not create or edit Claude, Codex, or Grok native provider configuration. It stores
  only the selected Codex provider id for a bundled Agent.
- Reset removes all app-level fields for the selected built-in Agent. There is no per-field reset,
  which keeps the semantics deterministic and allows future packaged defaults to flow through.
- User and project Agents retain their existing editing and resolution behavior.

## Follow-ups

No unresolved material finding remains. Provider fields for future adapters should be added only
after their native runtime requires an explicit selection.
