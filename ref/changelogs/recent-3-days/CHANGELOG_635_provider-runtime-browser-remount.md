---
changelog_id: 635
changed_at: 2026-09-03
---

# CHANGELOG_635_provider-runtime-browser-remount: Refresh runtimes and remount Browser contexts

## Summary

Agent Deck now packages the current stable Claude, Codex, and Grok runtimes together with compatible
updates on the application's existing dependency lines. Long-lived interactive sessions also renew
and remount their private `agent-deck-browser` launcher before each real provider turn, so an
overnight resume no longer requires a new session.

## Changes

### Embedded provider dependencies

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.241` to `0.3.260`, including all eight
  supported platform packages and their vendored Claude Code executables.
- Updated `@anthropic-ai/sdk` from `0.120.0` to `0.123.0`.
- Updated `@openai/codex` from `0.149.0` to `0.153.2`, including all six native platform aliases.
- Updated `@xai-official/grok` from `1.0.5` to `1.0.13`, including all six native platform
  packages.
- Confirmed `@agentclientprotocol/sdk` remains current at `1.4.0` and regenerated
  `pnpm-lock.yaml`.

### Compatible application dependencies

- Updated production packages without crossing their current compatibility lines: Feishu SDK
  `1.70.0` to `1.73.3`, Fastify `5.8.5` to `5.12.1`, React and React DOM `19.2.7` to `19.2.8`,
  Zod `4.4.3` to `4.5.4`, and Zustand `5.0.14` to `5.0.15`.
- Updated compatible build and test packages: Tailwind/PostCSS integration `4.3.0` to `4.3.3`,
  Testing Library React `16.3.2` to `16.3.3`, Node 22 and React type packages, Autoprefixer,
  Happy DOM, `png-to-ico`, and PostCSS.
- Refreshed compatible transitive resolutions and synchronized the Feishu deployment pin. Retained
  the existing major lines for Electron, Vite, Vitest, TypeScript, `better-sqlite3`, Electron
  Toolkit, and Electron Store; Monaco `0.56` was also excluded because its `0.x` minor boundary
  does not promise compatibility.

### Browser resume lifecycle

- Renew the session-private Browser capability at the actual Claude, Codex, and Grok provider-turn
  boundary instead of only when constructing the provider process.
- Recreate a purged private runtime directory, command shim, and context file at the same path
  already present in the provider's `PATH`, then rotate the old lease and runtime generation.
- Renew the exact host-owned portable lease for isolated Server Core Grok providers without
  exposing a replacement capability or host path to the container.
- Keep renewal best-effort: Browser repair failures are logged but cannot reject an otherwise valid
  model turn, while close/delete/handoff still revoke the capability through the existing lifecycle.

### macOS application package

- Built the arm64 application and DMG with Worker runtimes Claude Code `2.1.260`, Codex CLI
  `0.153.2`, and Grok Build `1.0.13`.
- Revalidated the macOS Worker bookmark, sandbox, provider-native boundary, and packaged runtime
  signatures after the dependency refresh.

## Validation

- Registry dist-tag, engine, peer, and optional-platform metadata checks.
- `pnpm update --ignore-scripts`, pinned Feishu SDK installation, and `pnpm postinstall`.
- Claude Agent SDK import smoke and direct packaged runtime version checks.
- Focused provider and Browser coverage: 13 files and 100 tests passed.
- `pnpm typecheck`.
- `pnpm test`: 1,017 files and 6,344 tests passed; 2 files and 3 opt-in tests skipped.
- `pnpm build`.
- `pnpm build:feishu-runtime`, `bash deploy/linux/feishu/static-check.sh`, and
  `pnpm check:deployment`.
- `pnpm test:browser-electron`.
- `pnpm verify:bundled-runtimes`.
- `pnpm logger:check` and `git diff --check`.
- `pnpm dist:mac` and packaged Worker runtime version checks.

## Do Not Split Protection

No exception is required. Changed production files remain at or below 500 lines. The Codex
`thread-loop.ts` reaches exactly 500 lines; the change is one turn-boundary host call and does not
create a new responsibility that would justify a broader split.

## Notes

The README already documents version-independent bundled runtime selection and the session-private
Browser contract, so no workflow or setup documentation change was required.

## Related review

- `ref/reviews/recent-3-days/REVIEW_266_browser-runtime-remount.md`
