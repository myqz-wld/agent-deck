---
changelog_id: 401
changed_at: 2026-07-27
---

# CHANGELOG_401_provider-usage-runtime-control-fidelity: Preserve provider truth

## Summary

Token totals now contain only values returned by Claude Code, Codex CLI, or Grok Build. Missing
provider usage remains missing; the lightweight live token/s display may still estimate text
throughput, but those estimates never enter persisted usage.

Session runtime controls now follow adapter ownership across CLI, IPC, MCP spawn, hand-off, resume,
and UI surfaces. Claude Code exposes the supported manual, accept-edits, plan, auto, and bypass
permission modes, Codex surfaces native
app-server approval requests without forcing ordinary sessions to `approvalPolicy: "never"`, and
Grok Build keeps ACP-native modes and permissions. A control owned by another adapter is rejected
instead of being accepted and silently discarded.

## Changes

### Authoritative usage

- Remove Claude's approximate `system/thinking_tokens` persistence and all durable assistant-frame
  accounting. The authoritative result is the sole persisted source. A single model may fill
  omitted detail fields from the exact aggregate result; unattributed multi-model reasoning is
  stored in a reasoning-only fallback row instead of being guessed or proportionally distributed.
- Treat Codex app-server `outputTokens` as already including reasoning tokens. Live token/s and
  persisted totals no longer add `reasoningOutputTokens` a second time.
- Preserve exact Codex `cacheWriteInputTokens` and Grok `cachedWriteTokens` as cache-creation
  usage instead of replacing them with zero.
- Preserve exact provider totals in a dedicated nullable column. Every applicable but unreported
  input, output, reasoning, or cache metric remains `NULL` from event through SQLite, IPC,
  aggregation, and UI; it is displayed as unavailable rather than fabricated as zero. A metric
  applicability mask distinguishes such unknowns from deliberately out-of-scope fields such as an
  unattributed Claude reasoning-only row.
- Add migration v048 to subtract reasoning from historical Codex output totals only for rows that
  contain the exact separately persisted reasoning value. Older rows that cannot be reconstructed
  exactly are intentionally left unchanged.
- Add migration v050 and a per-session Grok cumulative usage watermark. Recovered sessions compute
  deltas from the persisted snapshot; legacy sessions establish a baseline without recounting
  historical totals. Usage rows, provisional replacements, and watermark advancement commit in one
  SQLite transaction and roll back together.
- Persist partial and total-only Grok extension usage. A late extension replaces its correlated
  provisional ACP row, and history import uses compatible metric/timestamp matching so the same
  turn is not counted twice.
- Treat a Grok correction for an already completed turn as historical-only even when the next
  turn is active or inside its standard-usage grace window. It neither completes/cancels the
  current tok/s lifecycle nor persists that turn's still-uncommitted cumulative watermark.
  Cache-write-only and reasoning-only corrections can replace a nearby contradiction-free
  fallback without inventing overlapping metrics.
- Classify an explicitly older Grok correction before compatibility matching, safely advance only
  the completed turn's newly discovered cumulative metrics, and recompute an in-grace later delta
  against that corrected baseline. Zero-overlap live/history reconciliation now requires one
  model-compatible candidate; repeated canonical prompt rows remain idempotent upserts.
- Track metrics already covered by a cumulative Grok snapshot when the persisted turn-start value
  is unknown. A current, late, or progressive extension can fill that turn's canonical row without
  adding the same value to the cumulative frontier again.
- Treat a fresh first cumulative Grok snapshot as attributable current-turn usage rather than a
  restored historical baseline. A larger in-grace extension advances only the provider correction,
  so the next cumulative delta starts at the corrected frontier without double counting.
- Preserve the per-prompt cumulative coverage mask across back-to-back progressive extensions that
  arrive before grace cleanup. Already-covered metrics remain excluded while genuinely new
  corrections advance the frontier exactly once.
- Add migration v051 to make usage metrics presence-aware, retain exact provider totals, and record
  per-metric applicability while preserving indexes. Ambiguous zeros from the old non-presence-aware
  schema migrate conservatively to unavailable rather than being asserted as exact provider zeros.
- Keep token/s display-only and simple: Codex uses provider ticks; Claude and Grok may use their
  existing transient text-throughput estimate.

### Provider-native permissions and sandboxes

- Expose Claude Code `default` (manual), `acceptEdits`, `plan`, `auto`, and
  `bypassPermissions`. Retire public `dontAsk`, but preserve a provider-reported/stored `dontAsk`
  state exactly for the current session and recovery and show it read-only. CLI/IPC/MCP and
  selectors still reject or omit it; fresh child/fork/handoff sessions use manual confirmation
  rather than propagating it. Internal tool-free one-shot calls remain isolated from this UI/API
  contract.
- Stop forcing ordinary Codex sessions to `approvalPolicy: "never"`. Codex config/provider
  defaults remain authoritative; reviewer-codex retains an explicit non-interactive `never`
  exception.
- Persist that explicit Codex approval override through new, resume, recovery, JSONL fallback,
  native fork, hand-off, and session rename paths (migration v049). The Codex permission panel now
  shows the current session override instead of claiming that every reviewer is provider-owned.
- Inherit that override plus reviewer network/directory controls during native same-adapter forks,
  and backfill `never` for recognizable legacy reviewer-codex sessions during migration.
- Send `excludeTurns: true` on Codex app-server resume and fork requests so restored historical
  `last` usage notifications cannot be inserted as live turns after process recycle.
- Implement app-server initiated approval transport for command execution, file changes, expanded
  permission grants, and legacy approvals. Pending rows use Codex's exact decision vocabulary and
  are aborted when app-server resolves, recycles, exits, or closes the request.
- Merge Codex `extraAllowWrite` with `additionalDirectories` into workspace-write
  `writableRoots`, preserving it through create, fork, resume, recovery, and hand-off.
- Keep Grok Build on ACP-native permission requests and `default` / `plan` / `ask` session modes;
  Claude or Codex controls are rejected. Its permission view now renders only ACP-native controls
  and does not invoke Claude/Codex filesystem scanners.

### Adapter-owned public controls

- Add one adapter runtime-control contract used by CLI, IPC, MCP, hand-off, runtime profiles, and
  tests.
- Add strict per-adapter MCP schemas as the ownership source of truth. The current MCP tool
  transport still advertises a flat compatibility shape because its raw-shape serializer cannot
  represent a top-level discriminated union; field descriptions name the owner and runtime
  validation rejects every incompatible field.
- Reject foreign permission, session-mode, sandbox, provider, and writable-root controls instead
  of narrowing them away in CLI, IPC, MCP, or hand-off paths.
- Make the `resources/bin/agent-deck` launcher apply its default `bypassPermissions` only to
  Claude Code rather than leaking the flag into Codex or Grok payloads.
- Extract app-server request hosting, Codex permission hosting, and IPC runtime-control parsing so
  changed production facades remain within the 500-line guardrail.

## Validation

- Rebased without conflict onto `origin/main` at `abc9f818`.
- `pnpm typecheck` passed.
- `pnpm test` passed 383 files and 3,198 tests; one explicit live smoke test remained skipped.
  SQLite migration tests ran under Electron's ABI, including v048.
- `pnpm build` passed.
- `pnpm logger:check` and `git diff origin/main...HEAD --check` passed.
- `bash scripts/file-level-review-expiry.sh` ran before finalization.
- Installed Claude Code and Codex protocol typings were checked for the exact supported modes,
  request methods, permission profiles, and response vocabularies.
- Review-follow-up validation passed `pnpm typecheck`, 386 Electron-ABI test files / 3,245 tests,
  `pnpm build`, `pnpm logger:check`, launcher `bash -n`, and `git diff --check`. One credentialed
  live smoke test remains explicitly skipped.
- Migration v049-v051 tests cover nullable token fields, metric applicability, conservative legacy
  zero handling, exact provider totals, index recreation, approval/watermark row projection,
  transactional rollback, provisional/history replacement, and rename continuity.
- Follow-up targeted tests cover out-of-scope daily totals, provider-only Claude `dontAsk`
  status/recovery/query/UI behavior, adjacent Grok turns with a prior late extension before and
  during the current grace window, completed-prompt progressive updates, optional-only
  live/history reconciliation, explicit-old contradictions, ambiguity, repeated backfill, and
  unknown-baseline cumulative metrics in both grace orders. The six-file Grok/storage suite passed
  71 tests, including covered and uncovered back-to-back progressive notifications before cleanup
  followed by their next cumulative snapshots.
- One persistent `gpt-5.6-sol max` reviewer completed seven review/remediation rounds and returned
  PASS with no actionable findings; AFR-001 through AFR-012 are closed.

## Do Not Split Protection

- `src/main/adapters/claude-code/sdk-bridge/sdk-message-translate.ts` remains 688 lines. It was
  already 700 lines and this delivery reduced it by removing approximate thinking-token state.
  It remains the established single SDK message dispatcher; the new authoritative reasoning
  accounting is already extracted. Revisit when another independent message family is added.
- Changed test files above 500 lines and SQL migrations are exempt under repository policy.

## Notes

- No live paid-provider session was run. Deterministic transport fixtures and installed protocol
  definitions cover the behavior, but a future manual smoke can confirm Pending-row interaction
  against each provider.
- Prompt-asset inventory and pre-edit backups are retained under the ignored
  `.prompt-asset-improver/local/` workspace. The manifest records original hashes and paths; restore
  by copying the corresponding manifest entry back to its `original_path`.
- The completed implementation plan is archived as
  `ref/plans/recent-3-days/PLAN_20_provider-usage-runtime-control-fidelity.md`.
