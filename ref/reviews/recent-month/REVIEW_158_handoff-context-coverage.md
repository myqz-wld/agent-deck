---
review_id: 158
reviewed_at: 2026-07-14
baseline_commit: f10b04391299b85b620ea08466dc951b1b3bec3d
expired: false
skipped_expired:
  - file: "*"
    reason: "This focused review covers only the machine-readable runtime-control and Continuation Context scope below."
---

# REVIEW_158_handoff-context-coverage: Runtime persistence and hand-off context coverage

## Scope and method

This review correlated installed-application logs, read-only SQLite metadata, provider rollout
contexts, a credentialed hardened-runtime reproduction, focused regressions, and the complete
repository test/build gate. It covers both user-requested behaviors: automatic next-turn model /
Thinking persistence and the shared UI/MCP hand-off Continuation Context degradation.

```review-scope
README.md
src/main/session/continuation-context/__tests__/budget-policy.test.ts
src/main/session/continuation-context/__tests__/checkpoint-fold-chunk.test.ts
src/main/session/continuation-context/__tests__/handoff.test.ts
src/main/session/continuation-context/__tests__/service.test.ts
src/main/session/continuation-context/budget-policy.ts
src/main/session/continuation-context/checkpoint-fold-chunk.ts
src/main/session/continuation-context/checkpoint-fold.ts
src/main/session/continuation-context/handoff.ts
src/renderer/components/SessionDetail/__tests__/ComposerSdk.test.tsx
src/renderer/components/SessionDetail/composer-sdk/SessionRuntimeControls.tsx
```

## Root cause and evidence boundary

Two recent MCP hand-offs both completed successfully but reported `quality=coverage-gap` after about
123 seconds. The larger source had capture revision 4,426 while checkpoint id 5 covered only revision
40. Its immutable source contained 1,059 revision groups / 740 semantic groups; tool telemetry
accounted for several megabytes while ordinary messages were only about 16 KiB.

At the old 32,000-token fold budget, the first two chunks reached only revisions 40 and 80, so even
four successful calls could not catch up. An isolated real Codex/default/high call reproduced the
hidden failure as a 120.445-second timeout. The identical bounded full-backlog prompt succeeded in
201.154 seconds when allowed 240 seconds. Provider `turn_context` records separately proved that an
implicit same-adapter hand-off kept `gpt-5.6-sol` / `ultra`; another target used the explicitly
requested `ultra`. Runtime model/Thinking inheritance was therefore not the degradation source.

## Findings

| Severity | Finding | Resolution |
|---|---|---|
| HIGH | Duplicated multi-megabyte tool telemetry, a 32k fold budget, and a 120-second shared hand-off deadline made semantic checkpoint catch-up impossible for a production-sized session. UI and MCP both consumed the stale checkpoint. | Compact bounded telemetry, conservatively deduplicate identical completed-tool input, raise the fold budget to 96k by default, and allow UI/MCP hand-off 300 seconds. A production-shaped regression reaches the final revision in one chunk. |
| MEDIUM | Automatic runtime persistence could introduce stale completion/error races across rapid edits or a session switch if implemented as independent fire-and-forget writes. | Serialize writes per session, coalesce model text, flush Thinking immediately, and gate completion effects by mounted session key plus revision. |
| MEDIUM | Generator failures surfaced raw error text but did not expose a stable stage/category, making the installed logs insufficient for safe root-cause classification. | Emit only bounded stage/category/provider-call/revision/deadline diagnostics and return a generic structured warning; a regression proves sensitive provider text is absent. |
| LOW | A rare validation repair after a near-deadline first call can still exhaust 300 seconds, and more than one honest pipeline stage can emit `coverage-gap`. | Residual and bounded. The engine keeps the last valid checkpoint plus immutable raw history and never fabricates semantic coverage. |

## Fixes landed

- Removed the explicit runtime apply action and made subsequent-turn selection persistence automatic,
  editable, per-session serialized, revision-aware, and StrictMode-safe.
- Preserved ordinary message evidence while capping only file/tool telemetry with explicit truncation
  metadata and hashes; retained unmatched/in-flight starts and end rows that omit input.
- Rebalanced generator input against a 32k response/runtime reserve, kept the 128k and 512 KiB caps,
  and changed only UI/MCP hand-off's deadline. Recovery retains its independent 30-second limit.
- Replaced raw failure strings with bounded operational diagnostics suitable for persisted logs and
  MCP warning metadata.

## Validation evidence

- Read-only application log/DB reconstruction and provider rollout inspection established the
  coverage-gap, latency, revision, telemetry-volume, and model/Thinking boundaries above.
- The isolated credentialed generator reproduction used the existing empty-cwd, read-only, no-network,
  no-MCP runtime and performed no production DB writes.
- `pnpm test` passed 286 files and 2,675 tests; one credentialed live smoke was skipped normally.
- `pnpm typecheck`, `pnpm build`, `pnpm logger:check`, and `git diff --check` passed.
- All changed implementation files remain below 500 lines. The advisory review-expiry and record hook
  checks passed after the final records were written.
- Browser automation was attempted through the required in-app surface but its bundled client could
  not redefine `process`. Focused React tests provide the UI behavior evidence without changing the
  running installed application that owns this session.

## Residual risk and deployment note

- The 300-second deadline has about 99 seconds of measured headroom over the successful reproduction,
  but provider latency and semantic repair can consume it. Honest fallback remains the safety policy.
- The installed Agent Deck host was not terminated from inside its active SDK session. A safe app
  restart or rebuilt installation is required before the running binary uses the main-process repair.
- Mechanical date rebucketing moved July 9-10 records from `recent-3-days` to `recent-week`; affected
  cross-links and all bucket indexes were updated separately from the reviewed runtime scope.
