---
review_id: 268
reviewed_at: 2026-09-04
baseline_commit: 072dd7a284eebc2752dab7e5d5505aa2ee480b77
coverage_kind: bounded-project-scan
expired: true
expiry_reason: "Breadth includes inventory and selected excerpts; this scan grants no whole-file exemption from future review."
---

# Project code quality scan

The scan identified **3 HIGH and 11 MEDIUM functional/security defects**, plus **4 LOW items**: one confirmed obsolete handoff implementation family, two architecture opportunities, and one test-command coverage gap. All were open at scan completion. Their subsequent authorized remediation is recorded in [REVIEW_269](REVIEW_269_project-code-quality-remediation.md). The Windows HIGH finding has verified command construction and language semantics; native Windows execution was not performed.

The user requested concurrent inspection of defects, architecture costs, compatibility and dead code, and explicitly excluded the deep/simple review skills. Four ordinary fresh Codex sessions performed independent, non-overlapping primary scans. The lead inspected build/resource/deployment entrypoints, checked source evidence, and reran every supplied reproduction. No source fixes, dependency changes, Git index/ref/commit changes, live provider calls, application restarts, installed-bundle changes or deployments occurred.

The source baseline is unchanged. This delivery adds only scan records, evidence and archive-index maintenance. The completed execution plan is [PLAN_47](../../plans/recent-3-days/PLAN_47_project-code-quality-scan.md).

## Scope and confidence

| Track | Tracked files inventoried/searched | Primary files directly inspected in full or relevant excerpts | Existing targeted tests |
| --- | ---: | ---: | --- |
| Runtime adapters | 601 | 95 | 9 files / 41 tests passed |
| Session, storage, MCP and shared contracts | 630 | 114 | 10 files / 118 tests passed |
| Desktop, renderer, preload, IPC and Browser | 689 | 108 | 4 files / 37 tests passed |
| Remote hosts, clients, gateways and protocol | 726 | 108 | 6 files / 41 tests passed |
| Lead build/resource/deployment checks | 156 additional tracked inputs inventoried | Selected scripts, entrypoints, contracts and finding locations | 29 deployment tests and 4 native installer tests passed |

The primary inventory covers all **2,646 tracked source/test files**. Direct inspection covered selected bodies or excerpts in **425 primary files**, plus cross-track context and lead checks. It is not line-by-line or exhaustive dynamic verification. Exact inventories, direct-read lists, original worker reports, reproduction sources and validation logs are preserved in the [evidence directory](project-code-quality-scan-evidence/README.md). `expired: true` intentionally prevents this broad scan from exempting partially inspected files from later reviews.

The following locations carry the accepted findings and their immediate contracts. Broader inspection scope and gaps are recorded separately in each worker report.

```review-scope
src/main/hook-server/server.ts
src/main/agent-deck-mcp/transport-http.ts
src/main/agent-deck-mcp/tools/helpers.ts
src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts
src/main/store/session-repo/worktree-transition-delete.ts
src/main/store/session-repo/lifecycle.ts
src/main/store/task-repo/task-repo-handoff.ts
src/main/store/task-repo.ts
src/main/store/task-repo/_deps.ts
src/main/adapters/claude-code/sdk-bridge/permission-responder-core.ts
src/main/adapters/claude-code/sdk-bridge/session-lifecycle-core.ts
src/main/adapters/grok-build/turn-queue.ts
src/main/adapters/grok-build/session-command-feedback.ts
src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts
src/main/notify/sound.ts
src/renderer/components/SessionDetail/use-file-changes.ts
src/renderer/components/SessionDetail/RemoteDiffPanel.tsx
src/renderer/App.tsx
src/renderer/remote-host/use-remote-host-snapshot.ts
src/main/browser-use/view-host.ts
src/main/browser-use/operation-executor.ts
src/main/index/bootstrap-infra.ts
src/hosts/local-worker/frame-bridge.ts
src/hosts/local-worker/daemon-frame-channels.ts
src/hosts/server-core/runtime-pending.ts
src/gateways/im/core-bounds.ts
src/gateways/im/validation.ts
src/gateways/im/commands.ts
src/gateways/feishu/mapper.ts
vitest.config.ts
scripts/install-local-macos.test.mjs
```

## High-priority findings

| ID | Location | Supported trigger and consequence | Repair direction |
| --- | --- | --- | --- |
| coordination-01 | `src/main/hook-server/server.ts:61` | A tokenless loopback request with an encoded or absolute-form path skips raw-prefix authentication but reaches the protected route. Real Hook translation plus in-memory SessionManager ingestion creates/updates unclaimed CLI history and can close its CLI record. MCP list/get exposes session metadata. | Attach auth to matched route policy and assert authenticated MCP transport input. Preserve downstream external read/write limits. |
| remote-01 | `src/hosts/local-worker/frame-bridge.ts:258` | A valid 1,037,404-byte activity response resets the default Relay stream after only 196,608 response bytes. The synchronous splitter fills initial credit plus the 512 KiB queue before network credit can return. | Connect daemon writes to actual downstream backpressure, or reconcile a bounded shared response/chunk contract. |
| desktop-01 | `src/main/notify/sound.ts:146` | On Windows, selecting an existing sound file with a PowerShell subexpression in its filename inserts executable syntax into generated PowerShell source. Playback/preview can execute it with the desktop user's authority. | Keep interpreter source constant and pass the path as data, or use a correct literal encoding. |

For coordination-01, the listener is loopback-only. The demonstrated durable poisoning uses an unclaimed CLI identity. Missing MCP authentication resolves to the external sentinel: **all 16 external-disallowed guards remain effective**, `task_list` remains empty, and the finding does not establish MCP spawn/send/shutdown or raw transcript access. Metadata reads and CLI event ingestion are demonstrated in isolated fixtures.

For desktop-01, the lead repeated actual command-construction capture and independently verified that PowerShell double-quoted strings evaluate subexpressions. This supports the code-execution risk inference; no native Windows exploit was run. macOS/Linux use different playback paths. See [Microsoft PowerShell 5.1 quoting rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-5.1#double-quoted-strings).

## Medium-priority findings

| ID | Primary location | Current failure | Repair direction |
| --- | --- | --- | --- |
| runtime-01 | `src/main/adapters/claude-code/sdk-bridge/permission-responder-core.ts:68` | Server Core approval sends only the decision; the responder replaces the omitted override with `{}`. Remote reports resolved while the approved Edit/Write/Bash arguments are lost. Desktop's explicit-input control succeeds. | Default to the original pending tool input while honoring explicit overrides. |
| runtime-02 | `src/main/adapters/claude-code/sdk-bridge/session-lifecycle-core.ts:149` | Strict Claude rollback waits for stream drain before the cleanup that wakes/ends the reusable input stream. It fails after one second, retains the candidate runtime and blocks the lower-budget handoff retry. Ordinary close succeeds in the control. | Initiate input/provider termination before waiting; release ownership after termination proof. |
| runtime-03 | `src/main/adapters/grok-build/turn-queue.ts:160` | Deleting a submitted, pre-echo prompt sends cancel without aborting its RPC. If the terminal response is absent, the queue waits 90 seconds, then starts the next prompt on the same transport with the old RPC still pending. | Cancel the matching RPC and establish terminal completion or transport retirement before draining the next turn. |
| desktop-02 | `src/renderer/components/SessionDetail/use-file-changes.ts:71` | Leaving Local Diff unsubscribes from events while keeping data; returning skips refresh because data is non-null. Completed changes made while hidden remain invisible. | Revalidate on activation or retain a lightweight dirty revision. |
| desktop-03 | `src/renderer/components/SessionDetail/use-file-changes.ts:59` | A normal 51-file burst refreshes only 50 records and discards the new cursor. The demonstrated 52-row list omits one row and reports no more pages. | Establish overlap/continuity before merging or reset/traverse the paging window. |
| desktop-04 | `src/renderer/App.tsx:385` | An older Remote selection queues its second step after a newer Local choice; the final persisted source becomes Remote. | Serialize complete source-selection intents or fence the second step before dispatch. |
| desktop-05 | `src/main/browser-use/view-host.ts:189` | `open --show` reaches the production default no-op show callback while returning `visible: true`; the tab stays in a transparent parking host. | Wire an owner-qualified presentation action and report actual visibility. Exact foreground/IAB behavior is a product choice. |
| remote-02 | `src/gateways/im/core-bounds.ts:37` | Ordinary newlines invalidate Feishu history and inbound text. A two-line history response yields `invalid_core_response` and zero replies. | Separate identifier restrictions from bounded human-text policy across mapper, commands and Core output. |
| remote-03 | `src/gateways/feishu/mapper.ts:201` | Group bot mention placeholders are not normalized before command parsing. `/select` fails or `/unsubscribe` is sent to the model instead of changing subscription. | Normalize only the addressed bot prefix while preserving other mentions and authority checks. |
| coordination-02 | `src/main/agent-deck-mcp/tools/handlers/enter-worktree-impl.ts:87` | From an initialized submodule, deriving the repository as the parent of git-common-dir creates the superproject worktree; exit then rejects the recorded repository identity. | Keep verified Git repository identity separate from display/default paths and use it consistently for enter/exit. |
| coordination-03 | `src/main/store/session-repo/worktree-transition-delete.ts:31` | Session deletion/retention cascades tasks but leaves dead dependency UUIDs in surviving tasks; real task_get returns them. Explicit task deletion cleans them correctly. | Clean doomed task references in every deletion transaction; consider normalized dependency storage separately. |

All MEDIUM items are accepted for a bounded repair follow-up. Their current user/data outcomes justify repair; no automatic source fix was part of this request. Grok missing-terminal-response frequency and later event misattribution were not measured. The Local Diff finding uses an ordinary completed first load and a real-size burst; a separate synthetic initial-load race was excluded.

## Dead code and architecture opportunities

**coordination-04 — confirmed obsolete methods/branch (LOW).** In `src/main/store/task-repo/task-repo-handoff.ts:60`, `reassignOwner(clear-team)`, `applyHandOffSkipPolicy` and `findOwnedDistinctTeamIds` remain reachable only through forwarding and dedicated tests. Production handoff and rollback use `preserve-team`, and the current public schema exposes none of the old clear/skip options. Remove that bounded implementation/type/facade/test family when cleanup is authorized. Preserve the live containing module, `reassignOwner(preserve-team)` and ordinary `cleanupBlocksReferences`.

**runtime-04 — one queue entry should own its metadata (LOW).** Codex represents one pending turn as three correlated arrays. Seven production modules synchronize padding, shifts, prepends and splices. A typed queue element with one queue owner would remove a present coordination cost; no existing metadata corruption is claimed.

**desktop-06 — share Diff paging state logic (LOW).** Local and Remote duplicate merge, refresh, cursor and load-more state, with an observed policy divergence. Extract that state logic while each source keeps its own identity, authorization and read implementation. This is linked to desktop-02/03 rather than another independent user defect.

**LEAD-01 — default tests omit installer tests (LOW).** Four `node:test` cases in `scripts/install-local-macos.test.mjs` are outside `vitest.config.ts:27` and have no package test step. Explicit selection through the default wrapper finds no tests; adding only the include pattern still uses the wrong runner. `node --test` passes all four. Add an explicit native test step or migrate those cases to Vitest.

The task-dependency, Relay response and Feishu text findings also demonstrate split ownership of a single invariant. Prefer the localized repairs above first; a task-dependency schema migration is a separate design choice.

The production graph reaches 1,602 modules from Electron main/preload/renderer and all 11 headless roots. The 17 remaining files are active test fixtures/helpers. There is no newly confirmed dead **whole module**; coordination-04 is dead code inside a live module. Current Browser operation-name mappings, Server Core Browser registration, identity/history recovery, handoff aliases and rollback boundaries remain required. REVIEW_267's deleted Image MCP and retired Local Browser chains were not re-reported.

## Validation and lifecycle

- `pnpm typecheck` passed, including architecture checks and 121 Core-to-Node boundary candidates.
- Deployment static checks, inspected CLI syntax, all 34 package-script entrypoints and non-generated resource roots passed.
- Targeted existing tests passed as listed above. They do not constitute a new whole-suite run.
- The lead reran **19 worker reproduction cases** and added one independent production Hook case: **20 probes passed by observing the current behavior**. One synthetic desktop race is deliberately excluded from the findings.
- Real SQLite probes used in-memory databases under the Electron-compatible wrapper. The native binding hash was unchanged before/after the final SQLite verification.
- The file-level review-expiry script was run before inspection. Existing typed plan/review buckets were recalculated for 2026-09-04; REVIEW_215 moved to the inclusive 30-day bucket. Policies and root routing indexes did not change.
- All four worker sessions were closed after their required results were consumed and verified. Their ids, anchors and acceptance records are in [provenance.json](project-code-quality-scan-evidence/provenance.json).
- No full build, complete suite, live provider/Browser smoke, native Windows run or deployment was performed. Exact coverage gaps and counter-evidence remain in the four worker reports.

## Fixes landed and handoff

No implementation fixes landed. The scan and evidence handoff are complete; the listed defects remain open. Start remediation with the token boundary and Relay response contract, then address ordinary approval, Diff and source-selection behavior. Windows sound hardening applies before a Windows release. Dead-method cleanup can be a separate small change preserving current handoff semantics.
