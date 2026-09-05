---
plan_id: 48
completed_at: 2026-09-04
status: completed
baseline_commit: 072dd7a284eebc2752dab7e5d5505aa2ee480b77
---

# Verified quality finding remediation

- Status: completed; all accepted source items implemented and validated.
- Baseline: `072dd7a284eebc2752dab7e5d5505aa2ee480b77` on `main`.
- Source of findings: `ref/reviews/recent-3-days/REVIEW_268_project-code-quality-scan.md` and its evidence directory.
- Existing worktree changes: only the previous scan's final records, evidence and index rebucketing. Preserve all of them. Baseline diff/status captured in this invocation's ignored review workspace.
- Goal: fix all 14 accepted functional/security defects, retire the one obsolete handoff implementation family, address the two bounded queue/Diff architecture opportunities, and include the four installer tests in the default suite.
- User preference: ordinary sessions; do not use deep-review or simple-review skills or reviewer Agents. Continue the established parallel workflow with disjoint write areas. No native or recursive delegation by workers.

## Invariants and implementation decisions

1. Keep the current source worktree: existing dirt is the lead's scan records; workers have disjoint source ownership and the lead owns shared integration/archives. No worktree switch, commit, stash, reset, merge or ref mutation is needed.
2. Preserve existing public protocols, auth limits, supported data sizes and recovery semantics. Restore the accepted intended behavior rather than remove affected features.
3. Hook authentication follows the matched route and the MCP transport requires a valid auth result. External metadata-read scope remains distinct from session write scope.
4. Relay must deliver currently valid responses with bounded memory/backpressure; lowering the supported event payload/page contract is excluded.
5. Task dependencies remain in the current schema. Clean references transactionally on session deletion/retention, covering both edge directions. No migration or new task lifecycle semantics.
6. Browser explicit show requests focus the owning local session and present its IAB tab; default background behavior and owner isolation stay intact. Report actual/reliably completed presentation rather than an unconsumed flag.
7. Human Feishu text accepts ordinary LF/CR/TAB while identifiers remain strict. Remove only the addressed bot's mention prefix and preserve other mentions, owner/tenant/app checks, and group redaction.
8. Codex queue entries own their related metadata through one typed queue representation; preserve public enqueue/acceptance/cancellation behavior. Share Diff paging/refresh state where it prevents the demonstrated continuity and activation bugs; retain per-source authorization and identity.
9. Retire only clear-team/skip/distinct-team handoff code that lacks production callers; preserve preserve-team handoff/rollback and normal task-reference cleanup.
10. Migrate the existing installer `node:test` cases into the default Vitest discovery/runner rather than introduce another user validation command.
11. Running Agent Deck apps, development listeners and installed bundles are user-owned. No stop/restart/relaunch/install/deploy/native-binding rebuild. Report restart requirements after validation; obtain exact target/action approval before any such process operation.
12. Avoid packaged prompt/skill/tool-description changes. If a required public-contract or prompt change emerges, report its exact necessity before expanding scope. New UI/CLI text follows `UI_COPY_LANGUAGE.md` (Simplified Chinese).

## Work and ownership

| Task | Owner | Findings | Writable source areas | Task record |
| --- | --- | --- | --- | --- |
| runtime | Ordinary Codex worker | runtime-01/02/03/04 | `src/main/adapters/` only, with associated tests/submodules | [runtime evidence](../../reviews/recent-3-days/project-code-quality-remediation-evidence/runtime/report.md) |
| remote | Ordinary Codex worker | remote-01/02/03 | `src/hosts/local-worker/`, `src/hosts/daemon/`, `src/hosts/feishu/`, `src/gateways/` only, associated tests/submodules | [remote evidence](../../reviews/recent-3-days/project-code-quality-remediation-evidence/remote/report.md) |
| desktop | Ordinary Codex worker | desktop-02/03/04/05/06 | Renderer, Browser host/IPC/preload and explicitly listed cross-process wiring; excludes sound and all other task source areas | [desktop evidence](../../reviews/recent-3-days/project-code-quality-remediation-evidence/desktop/report.md) |
| lead | Lead | coordination-01/02/03/04, desktop-01, LEAD-01 | Hook server/MCP HTTP auth, worktree enter/exit identity, task/session deletion, handoff dead code, notify sound, installer test discovery, integrated validation and final records | This plan |

Workers append implementation/outcome evidence to their own task file; the lead owns assignment sections, acceptance, global records and indexes. Preserve unattributed changes and report required write-set expansion. Cross-area producer/consumer changes must stay with one owner or be explicitly coordinated before editing.

## Validation

- Add focused production regression cases for the confirmed triggers; retain counter-cases for auth, payload bounds, stale epochs, accepted-message races, and live handoff transfer.
- Worker checks use `pnpm run test <target paths> --maxWorkers=1 --minWorkers=1` through the existing Electron-compatible wrapper. Fake/temporary ports and databases only. No live providers or deployment actions.
- Lead validates each worker diff/result, runs integrated `pnpm typecheck`, the complete `pnpm test`, and `pnpm build` for the overall structural change. Protect/check the SQLite binding fingerprint around native tests.
- Re-run source-entrypoint and IPC/registration consistency checks for affected boundaries. Newly edited source should satisfy the 500-line guard; split pure types/helpers/tests where useful, or record a concrete reason and revisit trigger.
- The old probes assert faulty behavior; replace them with permanent desired-behavior regressions in the appropriate suites, rather than expect the old probes to stay green.
- Finalize new review/changelog as required, completed plan, indexes and record buckets. Preserve the original scan as historical evidence and link the remediation disposition.

## Progress

1. Complete: reviewed the accepted findings, source baseline and project/copy conventions.
2. Complete: three ordinary workers delivered bounded implementations; lead inspected the producer/consumer contracts and all finding locations. Worker focused checks: runtime 46 files / 243 tests, remote 33 files / 256 tests, desktop 34 files / 232 tests.
3. Complete: lead implemented matched-route Hook auth, MCP transport defense, data-only Windows sound paths, verified Git checkout/common-directory identity, transactional session/task deletion cleanup, obsolete handoff retirement and installer test discovery.
4. Complete: lead focused security checks (5 files / 48 tests), Git identity checks (4 files / 17 tests), and storage/handoff checks (140 tests, with a corrected fixture import rechecked); task tool suite split recheck (3 files / 44 tests). Global typecheck and architecture boundaries passed after correcting one test-only type import.
5. Complete: final typecheck and architecture checks passed; full suite passed 1,022 files / 6,335 tests with three environment/opt-in skips; production build passed. Source/IPC/dead-symbol consistency, line limits and native-binding fingerprint verified.
6. Complete: accepted and closed all three workers, completed their tasks, archived final records/evidence, and linked the original scan to the remediation. No live host action was performed.

## Risks and next action

- Windows execution was unavailable locally; data-only invocation and command construction were verified. Native Windows and OS-level Browser/Feishu/network behavior remain platform acceptance limits.
- Relay async backpressure and Browser presentation can expose adjacent lifecycle races; stay within the documented contracts and add bounded cancellation/teardown checks.
- No open product-policy decision blocks the localized remedies above. A database migration, smaller payload contract, new permission mode or altered retention policy is outside this plan.
- Handoff: source delivery is complete in the current checkout, without a commit, deployment or host restart. Use the existing separately authorized release/restart workflow when activating the built changes.

## Final handoff and archive routing

This delivery consists of review-driven fixes and internal refactors. The final remediation is [REVIEW_269](../../reviews/recent-3-days/REVIEW_269_project-code-quality-remediation.md) and this completed plan is PLAN_48, with supplemental evidence under `ref/reviews/recent-3-days/project-code-quality-remediation-evidence/`. Root routing rules place debug/security/review-driven fixes in reviews; no separate changelog or README change is needed. Numbered maxima and every plan/review date bucket were checked before finalization; no further rebucketing was required.
