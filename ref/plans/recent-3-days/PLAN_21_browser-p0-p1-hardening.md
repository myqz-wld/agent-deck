---
plan_id: PLAN_21
title: Browser P0/P1 hardening
status: completed
created_at: 2026-07-27
updated_at: 2026-07-27
completed_at: 2026-07-27
base_branch: main
base_commit: abc9f8180a9e1e4b828a06c7ae5fff99a6af47a2
implementation_commits: 53830804, 28074a89, e4db8ffd, f965b127, 506a20d9, 29d06fc2, 7ca304b5
related_plan: PLAN_19
related_changelog: CHANGELOG_403
related_review: REVIEW_182
---

# PLAN_21_browser-p0-p1-hardening: Harden browser readiness, DOM coverage, and artifacts

## Identity and execution state

- Status: completed; disruptive live-client validation deferred at archive
- Created: 2026-07-27
- Base branch: `main`
- Base commit: `abc9f8180a9e1e4b828a06c7ae5fff99a6af47a2`
- Worktree: `/Users/wanglidong/Repository/agent-deck/.agent-deck/worktrees/feat__browser-p0-p1-hardening`
- Work branch: `feat/browser-p0-p1-hardening`
- Agent Deck tasks: T0 `c6cf7daa-5042-4c50-be7f-183e7854049a`; validation T5
  `f9fc017b-353e-4d01-9a02-31a58cef6eee`
- Related final plan: `ref/plans/recent-3-days/PLAN_19_cross-adapter-browser-engine.md`
- Review record: `ref/reviews/recent-3-days/REVIEW_182_browser-engine-p0-p1-solo-audit.md`
- Implementation commits: `53830804`, `28074a89`, `e4db8ffd`, `f965b127`, `506a20d9`,
  `29d06fc2`, `7ca304b5`
- Last completed step: the same standalone `gpt-5.6-sol` / `max` reviewer verified all 12 findings
  closed with `Coverage: COMPLETE`; REVIEW_182 and indexes were committed.
- Final handoff: all implementation commits are ancestors of current `main`; the feature worktree
  has been removed and `origin/feat/browser-p0-p1-hardening` contains the integrated branch tip.
- Deferred validation: live Grok/Claude and inline-image checks were not required for archival.
  The packaged official Codex Browser regression remains separately disruptive and still requires
  explicit approval before killing or overwrite-installing the running application.

## Goal

Close the approved P0/P1 gaps one at a time:

1. Add deterministic wait primitives for DOM readiness and network idle.
2. Add bounded retention and reaping for browser screenshots.
3. Extend snapshot refs through open shadow roots and same-origin iframes without breaking current
   refs or session ownership.

## Invariants

- Codex-only protocol quirks stay in `fronts/codex-pipe.ts`; do not add more provider facts to the
  engine. Preserve the load-bearing empty debugger-session normalization behavior.
- Browser state remains in the engine registry keyed by Agent Deck session id, never on an MCP
  transport or request.
- The HTTP MCP transport remains stateless with a fresh transport and server per request.
- Existing ref strings remain `<generation>-<index>` in this scope. A snapshot generation covers
  the top document, its open shadow roots, and same-origin descendant documents as one flattened
  deterministic traversal.
- Cross-origin and OOPIF traversal is explicitly excluded. Encountered inaccessible frames are
  reported in snapshot metadata instead of silently pretending coverage.
- Interactions still accept refs only. A selector, if approved for `browser_wait`, is a readiness
  query and never an interaction target.
- CDP network domains stay lazy for Codex pipe owners. MCP session tabs may arm internal network
  tracking at `browser_open`; this must not expose raw CDP or leak into Codex tabs.
- Screenshot deletion is restricted to the dedicated `os.tmpdir()/agent-deck-browser` tree and must
  not follow symlinks outside it.
- Page content and wait results remain labelled as untrusted.
- Every production TypeScript file remains below 500 LOC.
- A new MCP tool still requires the four mechanical edits: tool name, external deny entry, schema,
  and handler plus registration. Do not add definitions to the 488-line `tools/index.ts`.
- Prompt safety semantics remain aligned across Claude, Grok, and Codex assets. No `.bak` file may
  remain under `resources/`.

## Confirmed scope and exclusions

### Included

- One public wait tool covering selector readiness and network idle.
- DOM traversal through open shadow roots and same-origin nested iframes.
- Browser screenshot reaping at startup plus a throttled long-running-app trigger.
- Unit/integration coverage, prompt/tool documentation, final records, dev restart, and real adapter
  validation.

### Excluded

- Cross-origin iframe/OOPIF refs.
- Piercing closed shadow roots. Runtime coverage instead reports the structural boundary as
  `closedShadowRoots: "not-observable"`.
- Downloads, uploads, native dialogs, or login automation.
- Raw `browser_cdp`.
- Attached `WebContentsView`.

## Project evidence

- `engine/scripts.ts` currently runs one top-document `querySelectorAll` and stores refs in
  `window.__agentDeckBrowserRefs__`.
- `EngineTab.waitForSettle()` only polls `webContents.isLoading()` and cannot observe SPA readiness.
- `CdpBridge` has lazy Network-domain support and a request map, but removes requests at
  `Network.responseReceived`, which is too early for a true idle definition.
- `browser_open` is the earliest MCP-only point that can arm network tracking before navigation.
- Screenshot files are written by `tools/handlers/browser/inspect.ts` beneath
  `os.tmpdir()/agent-deck-browser/<session>/` with no cleanup.
- `store/image-uploads.ts::reapStaleUploads` is the repository pattern for guarded, non-fatal startup
  cleanup.
- `happy-dom` is already a dev dependency and can execute generated page scripts in focused tests.
- REVIEW_177 paths no longer mapped after the rename, so the user requested one standalone Codex
  audit. REVIEW_182 now covers the current engine, Codex front, MCP browser surface, lifecycle,
  prompts, and tests.

## Delivered result

- `browser_wait` ships selector and network-idle modes with public 30-second bounds and a
  main-process execution deadline.
- Open shadow roots and accessible same-origin nested frames share flat generation refs. One
  20,000-DOM-node budget covers elements and optional text.
- Screenshot artifacts have guarded seven-day cleanup. Full-page capture honors physical-pixel
  `maxWidth` on HiDPI displays and a 16-million-pixel ceiling.
- Remote pages have deny-by-default Electron permission policy, probes have no synthetic user
  activation, and automation close cannot be vetoed by `beforeunload`.
- Hidden-window keys reproduce target-aware defaults for editing, movement, focus, activation,
  scrolling, submission, textarea newlines, and native-dialog Escape.
- Every terminal session path disposes browser ownership; Codex remains official-plugin-only.
- Full validation after integrating current `main` passed: `pnpm typecheck`; `pnpm test`
  (389 files / 3,281 tests, one skipped);
  `pnpm test:browser-electron`; `pnpm build`; `pnpm logger:check`; diff, file-size, prompt-backup,
  and review-expiry checks.
- Prompt review backups are ignored and outside packaged resources:
  `.prompt-asset-improver/local/backups/20260727T112438Z/` and
  `.prompt-asset-improver/local/backups/20260727T121825Z/`.

## Spike reports

### S1 — Can same-origin frame and open-shadow elements keep the current ref format?

- Question: must this scope introduce a frame-qualified ref?
- Method: create a `happy-dom` top document, open shadow root, and same-origin iframe; flatten their
  button elements into one top-window ref array and interact with stored nodes.
- Result: all three nodes were connected, the iframe node retained its own `defaultView`, and a node
  from the iframe document could be stored and retrieved from the top-window state by identity.
- Conclusion: current `<generation>-<index>` refs can remain backward-compatible for the approved
  same-origin scope. Frame-qualified refs are deferred with cross-origin/OOPIF support.
- Remaining risk: real Electron scrolling and nested-frame visibility need a live fixture test.

### S2 — When must network tracking start?

- Question: can `browser_wait(kind:"network-idle")` enable Network only when called?
- Evidence: CDP Network events are not retroactive; the current bridge learns requests only after
  `Network.enable`.
- Conclusion: MCP session tabs must arm tracking in `browser_open` before optional navigation.
  Recording for `browser_read_network` remains separately gated so its documented non-retroactive
  buffer semantics do not change.
- Remaining risk: long-lived requests can prevent idle; the wait result and timeout must report the
  remaining in-flight count.

## Selected engineering route

### Wait primitive

- Add one `browser_wait` tool as a discriminated union rather than two tools.
- Selector mode polls a deterministic page script across the same recursive root traversal used by
  snapshot and supports `attached`, `visible`, `hidden`, and `detached`.
- Network-idle mode waits until tracked in-flight requests reach zero and stay quiet for a bounded
  idle window.
- Split CdpBridge network tracking from network-history recording. Track request lifetime through
  `loadingFinished` / `loadingFailed`; do not treat `responseReceived` as completion.
- Arm tracking only for MCP session tabs at open, never generically in debugger attach.

### Frame and shadow traversal

- Extract shared recursive traversal helpers so snapshot and selector waits cannot drift.
- Traverse each document in DOM order; immediately traverse an element's open shadow root, and
  traverse an iframe's `contentDocument` when same-origin access succeeds.
- Store ref entries with the element and its frame-host chain. Interaction scripts scroll the target
  inside its document and then scroll each containing frame into view.
- Return coverage metadata: document count, open shadow-root count, same-origin frame count, and
  inaccessible-frame count.
- New snapshots still invalidate every earlier ref for that tab.

### Screenshot lifecycle

- Move persistence out of the MCP handler into a small browser screenshot store.
- Reap only generated PNG files under the dedicated root, skip symlinks and unexpected entries,
  remove empty session directories, and swallow per-entry errors with bounded logging.
- Run once during bootstrap and opportunistically at most once per configured interval when a
  screenshot is persisted, so an app left open for weeks does not grow without bound.

## Decision ledger

### D1 — Public wait API

- Owner: user (public MCP API)
- Question: one `browser_wait` discriminated tool or separate selector/network tools?
- Recommended: one tool with `kind:"selector" | "network-idle"`.
- Benefit: one discoverable readiness surface, one new-tool wiring set, and room for later
  deterministic conditions without multiplying tools.
- Cost: the schema is a union and selector mode must be clearly distinguished from ref-only actions.
- Alternative: two narrower tools; simpler individual schemas but a wider long-lived tool surface.
- Answer: one `browser_wait` tool with `kind:"selector" | "network-idle"`.
- Confirmed by: user response `1A` on 2026-07-27.
- Status: confirmed

### D2 — Screenshot retention

- Owner: user (persistent deletion policy)
- Question: how long should saved browser screenshots remain?
- Recommended: seven days, reaped at startup and opportunistically no more than once per day.
- Benefit: enough time for debugging handoff while bounding a high-volume temporary artifact.
- Alternative A: fourteen days, aligned with uploaded-image cleanup but doubles worst-case growth.
- Alternative B: delete on session close, smallest footprint but invalidates paths immediately after
  handoff/close and makes debugging records fragile.
- Answer: retain for seven days; reap at startup and opportunistically no more than once per day.
- Confirmed by: user response `2A` on 2026-07-27.
- Status: confirmed

### D3 — Frame scope

- Owner: user (scope)
- Answer: open shadow roots and same-origin iframes are included; cross-origin/OOPIF is deferred.
- Evidence: user approved the recommended P0/P1 scope after the priority assessment.
- Status: confirmed

### D4 — Ref compatibility

- Owner: engineering
- Answer: preserve `<generation>-<index>` and flatten the approved traversal into one generation.
- Evidence: S1 plus no public need for frame-qualified routing until cross-origin support.
- Status: constrained

### D5 — Raw CDP

- Owner: user (security/API scope)
- Answer: excluded.
- Status: confirmed

### D6 — Wait defaults

- Owner: engineering
- Answer: default timeout 10 seconds, maximum 30 seconds, selector polling every 100 ms, and network
  idle after zero tracked requests for 500 ms. Timeout and idle window remain caller-overridable
  within bounded schema ranges.
- Rationale: callers can tune slow targets without changing the public route selected in D1.
- Status: constrained

## Decision checkpoints

- Checkpoint A — route selection: passed. D1-D3 and D5 fix every public API, scope, security, and
  deletion-policy choice that can change the route.
- Checkpoint B — spike-created choices: passed. S1 confirmed ref compatibility as an engineering
  constraint; S2 introduced no new product choice after D1.
- Checkpoint C — final review: passed after task synchronization. No material user-owned item remains
  unresolved. Public API, deletion policy, included DOM boundaries, and security exclusions are all
  confirmed; defaults and implementation mechanics are bounded engineering choices.

## Deterministic/model boundary

No production LLM call is introduced.

- DOM traversal, selector matching, visibility, ref generation, and stale checks are exact page
  scripts with JSON results.
- Network-idle state is event-driven counters plus monotonic timing.
- Reaping is filesystem metadata comparison and guarded deletion.
- Prompt assets describe the deterministic tool behavior; they do not participate in execution.
- Tests mechanically validate traversal order, stale refs, wait timeout/success, request lifecycle,
  path containment, TTL boundaries, and tool registration.

## Executable tasks

### T0 — Complete planning and isolation

- Status: completed
- Task id: `c6cf7daa-5042-4c50-be7f-183e7854049a`
- Dependencies: D1 and D2
- Steps: record answers; pass decision checkpoints; present final plan; ensure clean main; enter an
  Agent Deck worktree from local `main`.
- Done: approved plan, task store synchronized, worktree path recorded here.

### T1 — P0 wait primitive

- Status: completed
- Task id: `724d5b0a-e68c-4af6-b1aa-c12493004ef2`
- Dependencies: T0
- Write areas: engine CDP/actions/tab or new wait module; MCP types/schema/browser-tools/handler;
  focused tests.
- Validation: selector states, timeout, navigation destruction, network request lifecycle, quiet
  window, read-network non-retroactivity, external deny, adapter gating.
- Done: `browser_wait` is deterministic and existing Codex protocol assertions remain unchanged.

### T2 — P1 screenshot lifecycle

- Status: completed
- Task id: `b6745f46-00ef-4165-8e0d-2594f436a329`
- Dependencies: T1
- Write areas: new screenshot store, inspect handler, bootstrap, store tests.
- Validation: TTL boundary, symlink/unexpected entry handling, empty-dir cleanup, throttle, handler
  result path and inline image unchanged.
- Done: startup and long-running cleanup work without deleting outside the dedicated root.

### T3 — P1 frame and shadow refs

- Status: completed
- Task id: `03164888-ea4f-45df-b18a-568cc7f7f9c7`
- Dependencies: T2
- Write areas: page-script traversal module/scripts/actions; action and live fixture tests.
- Validation: top document, nested open shadow roots, nested same-origin frames, mixed traversal
  order, inaccessible frame count, stale generation, click/type/scroll, text aggregation and limit.
- Done: refs work across included roots with no ref-format change.

### T4 — Tool guidance and records

- Status: completed
- Task id: `34efa1dc-c13a-4877-a1ed-8079f897f654`
- Dependencies: T1-T3
- Write areas: Claude/Grok/Codex prompt audit, README tool surface, PLAN_19, new changelog/review
  records and indexes.
- Validation: prompt semantic comparison, local links, no `.bak`, indexes and buckets valid.
- Done: shipped guidance teaches selector waits versus ref-only interaction and states frame limits.

### T5 — Integrated validation and review

- Status: completed — deterministic and review validation passed; disruptive live-client checks
  deferred by the requester at archive
- Task id: `f9fc017b-353e-4d01-9a02-31a58cef6eee`
- Dependencies: T1-T4
- Validation: targeted tests, `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check`,
  file-size guard, review-expiry script, dev restart, Grok and Claude session E2E, official Codex
  Browser regression after explicit approval for the disruptive overwrite-install.
- Review scope: engine + Codex front + complete MCP browser tool surface. The requester replaced the
  earlier heterogeneous-review idea with exactly one standalone `gpt-5.6-sol` / `max` reviewer.
  REVIEW_182 records five HIGH, six MEDIUM, and one LOW finding, all fixed and verified closed.
- Deferred, non-blocking follow-up: Grok and Claude live E2E, inline MCP image rendering, and the
  packaged official Codex Browser regression. The latter still requires explicit disruptive
  approval. The implementation branch was pushed and its worktree was cleaned up before archival.

## Risks and rollback

- Network domain changes can interfere with the official Codex Browser client if armed generically;
  ownership-specific arming is mandatory.
- Selector waits can become an interaction escape hatch if handlers accept them; interaction schemas
  remain ref-only.
- Recursive traversal can exceed script/response budgets; preserve the single global DOM-node limit
  and bounded text aggregation.
- Same-origin status can change after navigation; each traversal catches access failures and reports
  coverage rather than retaining old frame state.
- Reaper mistakes are destructive; containment, file type, extension, and age checks all fail closed.
- Each gap lands as a separate commit so one feature can be reverted without discarding the others.

## Final status and handoff

Completed At: 2026-07-27

T0-T5 are closed for this delivery. Implementation, integration tests, build validation, real
Electron boundary fixtures, and the standalone REVIEW_182 repair-verification pass are complete.
The current `main` contains every listed implementation commit, the feature branch was pushed, and
the isolated feature worktree has already been removed.

Live Grok/Claude client checks, inline MCP image rendering, and the packaged official Codex Browser
regression remain optional validation follow-ups rather than incomplete implementation. Do not
package, overwrite-install, or terminate a running Agent Deck for the Codex regression without
fresh explicit approval. Preserve the Codex front normalization and session-owned registry
invariants in any future follow-up.
