---
changelog_id: 618
changed_at: 2026-08-18
---

# CHANGELOG_618_unified-browser-skill-cli-iab: Unify Browser use across adapters

## Summary

Unified interactive Claude Code, Codex CLI, and Grok Build browser work behind one bundled Browser
skill and the session-scoped `agent-deck-browser` CLI. Added a conditional responsive Session Detail
IAB with inner page tabs, background-first WebContentsView presentation, and frozen PNG annotation
that enters the existing composer without sending automatically.

## Changes

### Session identity and CLI

- Added one provider-neutral Browser operation contract and executor for open, tabs, navigate, wait,
  close, snapshot, screenshot, click, type, press, scroll, console, network, and evaluate.
- Added a Browser-only lease registry, authenticated local broker, strict versioned envelopes, bounded
  framing, replay/runtime-generation checks, and deterministic public errors.
- Added the packaged `agent-deck-browser` CLI and per-session command shim. The launcher supplies a
  private context out of band; model input cannot choose a session, owner, lease, token, endpoint,
  cwd, or provider identity.
- Injected the shim into interactive Claude, Codex, and Grok runtimes only when that adapter's
  existing Agent Deck Skills switch is enabled. Oneshot summary/checkpoint work remains Browser-free.

### Browser engine and Session Detail IAB

- Refactored browser tabs behind a WebContentsView-compatible surface and added an inactive,
  non-focusable opacity-zero parking host so background pages keep painting without appearing in
  front of the user.
- Added renderer/window/source-bound presentation leases, strict bounds clipping, typed IPC/preload
  methods, viewport revisions, source-qualified Local/Remote state, and lifecycle cleanup.
- Added an outer IAB entry immediately after Cross-session only while the selected session owns a
  browser tab. Multiple pages switch through an inner tab strip.
- Made the page follow the current narrow Session Detail panel responsively. Agent Deck never
  auto-expands the application; the user retains the existing shortcut and window-drag controls.

### Annotation and composer authority

- Added a frozen physical-PNG capture with CSS viewport, scroll, DPR, zoom, and viewport-revision
  metadata, plus bounded pen/circle strokes, undo, clear, cancel, and complete.
- Reparked the native view during annotation and invalidated drafts on resize, navigation, source,
  tab, or attachment-capability changes.
- Routed completed `iab-annotation.png` files only through the existing Local or Remote composer
  attachment state. Annotation has no direct send or steer path and never auto-sends.
- Hid annotation controls when the live adapter cannot accept PNG input and displayed the exact
  reason in Simplified Chinese inside the page.

### Remote projection and staged fallback

- Added a pure-Node Server Core Browser runtime, private provider projection, Desktop broker
  multiplexing, revisioned tab-state events, Workspace-safe screenshot artifacts, and Remote IAB
  presentation/annotation integration.
- Prevented Desktop-private paths, raw owner ids, Browser contexts, page bodies, and screenshots from
  entering Remote replay or persisted product state.
- Retained the Server Core `browser_*` MCP compatibility surface because the explicit live Colima
  target variable was unavailable. Remote never falls through to Local Browser state.

### Bundled skills and Local cutover

- Added byte-identical, self-contained Browser skills for Claude, Codex, and Grok, including the full
  CLI grammar, output/error contract, retry safety, ref lifetime, coverage boundaries, artifact
  handling, and untrusted-page rules.
- Rewrote the three adapter runtime Browser sections and README around skill + CLI, conditional IAB,
  background operation, responsive width, tabs, annotation, and staged Remote behavior.
- Disabled Local legacy Browser MCP registration for all three adapters.
- Stopped starting the official Codex Browser native-pipe backend and removed the Codex `node_repl`
  Browser bootstrap hook and its two packaged proxy files. User plugin caches and user Codex config
  were not edited.

## Validation

- Prompt/resource checks passed 7 files / 40 tests; surface-cutover checks passed 10 files / 82
  tests; all three skill copies have the same SHA-256.
- `pnpm typecheck`, architecture boundaries, `pnpm test:browser-electron`, the complete `pnpm test`
  suite, `pnpm build`, `pnpm logger:check`, `pnpm verify:linux-headless`, and `git diff --check`
  passed.
- The full suite left only the existing opt-in live Colima Provider and Codex live-smoke files
  skipped during its ordinary run.
- The explicit Colima command failed closed before mutation because
  `AGENT_DECK_PROVIDER_LIVE_DOCKER_HOST` was not configured. The Remote fallback remains enabled.
- Installed macOS wrapper freshness and fresh provider-session live checks are recorded separately
  when the final installed-app acceptance completes.

## Do Not Split Protection

All changed production application source files remain below 500 lines. Two existing repository
policy scripts remain over the guardrail: `scripts/check-architecture-boundaries.mjs` and
`scripts/check-core-node-boundaries.mjs`. This change only deleted the retired node_repl boundary
entries from those declarative rule tables; splitting either entire cross-repository policy table
inside this Browser feature would expand scope and increase policy drift risk. Revisit when either
script next gains behavior or a new rule family, and extract rule groups behind the current single
entrypoint at that time.

## Related review and plan

- `ref/reviews/recent-3-days/REVIEW_255_unified-browser-boundary-review.md`
- `ref/plans/recent-3-days/PLAN_43_unified-browser-skill-cli-iab.md`
