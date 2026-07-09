# History Reviews

## Scope

This bucket contains only reviews that currently belong to this mutually exclusive date range. Remove rows for files moved to another bucket during rebucketing.

| Bucket | Date Range |
|---|---|
| `recent-3-days` | `reviewed_at` is within the last 3 days, inclusive |
| `recent-week` | `reviewed_at` is older than 3 days and within the last 7 days, inclusive |
| `recent-month` | `reviewed_at` is older than 7 days and within the last 30 days, inclusive |
| `history` | `reviewed_at` is older than 30 days, or missing a parseable date |

Legacy records retain only authoritative metadata. Missing `reviewed_at` values are `unknown`, and missing severity aggregates are explicitly marked rather than inferred.

## Index Table

| reviewed_at | File | Topic | Severity Distribution |
|---|---|---|---|
| 2026-04-24 | `REVIEW_1.md` | Full review of critical main-process modules with Claude Opus 4.7 xhigh + Codex… | 3 HIGH / 4 MED / 1 LOW |
| 2026-04-24 | `REVIEW_2.md` | Full review of renderer, preload, shared, and adjacent main-process code with a… | 4 HIGH / 10 MED / 6 LOW |
| 2026-04-24 | `REVIEW_3.md` | Phase 4 N5 FTS5 post-landing review; Opus 4.7 xhigh ran sqlite3 CLI and EXPLAIN… | 1 CRITICAL / 2 HIGH / 1 MED / 2 LOW |
| 2026-04-24 | `REVIEW_4.md` | `origin/main..HEAD` adversarial review for CHANGELOG_19/20/21 across 19 files, … | 4 HIGH / 17 MED / 9 LOW |
| 2026-04-24 | `REVIEW_5.md` | Root-cause investigation for user report "continue historical session creates t… | 1 HIGH / 1 MED |
| 2026-04-24 | `REVIEW_6.md` | Root-cause investigation for user report "resume behaves like a new session": C… | 1 HIGH / 2 MED / 2 LOW |
| 2026-04-25 | `REVIEW_7.md` | Periodic review around CHANGELOG_24-29 disconnect self-healing, fork fallback, … | 1 HIGH / 4 MED / 4 LOW |
| 2026-04-28 | `REVIEW_8.md` | ExitPlanMode 4 target-permission levels and bypass cold-switch design review wi… | 2 HIGH / 2 MED / 3 LOW |
| 2026-04-28 | `REVIEW_9.md` | ExitPlanMode approve-bypass dual root-cause review for red `ede_diagnostic` emi… | 1 HIGH / 1 MED |
| 2026-04-29 | `REVIEW_10.md` | Packaging/install validation found main-process stdout EPIPE causing uncaughtEx… | 1 HIGH |
| 2026-04-29 | `REVIEW_11.md` | ExitPlanMode and permissionMode four-bug adversarial review: missing result-fra… | 4 HIGH / 2 MED |
| 2026-04-29 | `REVIEW_12.md` | Orphan external session after approve-bypass cold switch; fixed dual root cause… | 2 HIGH |
| 2026-04-29 | `REVIEW_13.md` | macOS "Agent error" notification after approve-bypass: REVIEW_11 D'2 gated red … | 1 HIGH |
| 2026-04-30 | `REVIEW_14.md` | Agent-session sandbox feasibility study: SDK 0.2.118 already has OS sandbox, ho… | 2 HIGH / 2 MED / 1 LOW + 4 unknown spike items |
| 2026-04-30 | `REVIEW_15.md` | Sandbox three-level implementation and live-test corrections; four implementati… | 7 fixed (3 HIGH + 2 MED + 2 LOW) + 4 rebutted assumptions + 4 unknown Phase 3 candidates |
| 2026-05-01 | `REVIEW_16.md` | fs watcher symlink path mismatch: chokidar/fsevents returned realpaths while co… | 1 fixed HIGH (3 paths same root cause) + 4 rebutted debug assumptions + 3 unknown no-change options |
| 2026-05-01 | `REVIEW_17.md` | First full review of Agent Teams, SDK Task Manager, and Inbox Watcher (+8980 li… | 2 HIGH + 9 MED + 5 LOW + INFO not fixed |
| 2026-05-01 | `REVIEW_18.md` | Large-file split S1+S2+S3 validation: 21 files / 3 commits / +2023 -1793, byte-… | 0 HIGH / 0 MED / 0 LOW + 1 INFO |
| 2026-05-01 | `REVIEW_19.md` | Second large-file split P1+P2+P3+P4 validation: 19 files / 4 commits / +1675 -1… | 0 HIGH / 0 MED / 1 LOW + 4 INFO, all 4 fixed in-review |
| 2026-05-01 | `REVIEW_20.md` | Third large-file split Step 1-4c validation: 22 files / 11 split commits + 1 au… | 0 HIGH / 0 MED / 0 LOW + 1 INFO, fixed in same commit |
| 2026-05-04 | `REVIEW_21.md` | Cross-platform Windows support infrastructure inventory with reviewer-claude Op… | 3 HIGH / 5 MED / 5 LOW, including 1 downgraded after rebuttal |
| 2026-05-06 | `REVIEW_22.md` | CHANGELOG_57 asset library, platform routing, and copy unification three-round … | 1 HIGH / 7 MED / 6 LOW + 3 unknown in R1 + 2 MED fixed in R2 + 0 in R3 |
| 2026-05-11 | `REVIEW_23.md` | R3 PR-A E0 ADR reviewer adversarial review closed in ADR section 13 plus PR-B v… | 5 HIGH fixed + 3 HIGH-to-MED + 7 MED + 5 rebutted + INFO, see ADR section 13 |
| 2026-05-12 | `REVIEW_24.md` | R4 Generic-PTY implementation review: reviewer-codex wrapper failed three times… | 2 HIGH / 7 MED / 2 LOW + 2 rebutted + 4 unknown |
| 2026-05-12 | `REVIEW_25.md` | Packaging/install exposed main bootstrap `TypeError: syncAgentDeckSection / syn… | 1 HIGH fixed + 1 rebutted specifier hypothesis + 1 unknown vite-warning rescue mechanism |
| 2026-05-12 | `REVIEW_26.md` | AskUserQuestion / ExitPlanMode were incorrectly rendered as failed red boxes in… | 1 HIGH fixed + follow-up 1 HIGH fixed |
| 2026-05-12 | `REVIEW_27.md` | Packaged install exposed bootstrap MCP HTTP transport mount failure `FST_ERR_IN… | 1 HIGH / 1 LOW + 1 unknown |
| 2026-05-12 | `REVIEW_28.md` | User-tested deep-code-review SKILL hit spawn-guards same-cwd same-adapter denia… | 3 HIGH / 6 MED / 4 LOW + 1 unknown upgraded to fixed |
| 2026-05-13 | `REVIEW_29.md` | Commit/push/package/install exposed two bootstrap blockers: refractor v5 ESM ex… | 2 HIGH fixed + 2 rebutted stage hypotheses + 3 unknown |
| 2026-05-13 | `REVIEW_30.md` | deep-code-review SKILL triplet plus two CLAUDE.md files adversarial review and … | 12 HIGH / 14 MED / 15 LOW / 1 unknown |
| 2026-05-13 | `REVIEW_31.md` | deep-code-review SKILL live test immediately found 5 independent bugs: bundled … | 2 HIGH + 3 MED fixed |
| unknown | `REVIEW_32.md` | 50-commit adversarial review plus "lead archive to team auto-archive" fix for p… | 6 HIGH fixed + 1 MED-to-HIGH fixed + 1 MED fixed + 1 HIGH fixed + 4 MED follow-up + 2 LOW + 2 INFO + 2 future HIGH |
| unknown | `REVIEW_33.md` | Five instruction documents review and optimization for user CLAUDE, app CLAUDE,… | 4 HIGH fixed + 9 MED fixed + 2 LOW fixed + 2 rebutted + 1 unknown |
| unknown | `REVIEW_34.md` | mcp-bug-and-feature-batch-20260513 plan plus CHANGELOG_95, 19 commits / 67 file… | 10 HIGH (9 fixed + 1 unknown) / 14 MED / 13 LOW+INFO + 5 unknown partial |
| unknown | `REVIEW_35.md` | Twelve hot files in 4 batches x3 files across 3 adversarial rounds; 49 R1 findi… | 9 HIGH / 20 MED / 7 LOW + 18 MED follow-up + 25+ LOW/INFO follow-up |
| unknown | `REVIEW_36.md` | Sandbox, resume, and hand-off real-effectiveness review across 11 files ~3300 L… | 4 HIGH in R1 + 5 true issues in R2 (2 HIGH + 3 MED) + 3 LOW + multiple INFO + user base_branch fix |
| unknown | `REVIEW_37.md` | Macro refactor opportunity review across R1+R2+R3 with P1+P2+P3 landing; 16 com… | 8 fixed HIGH (R1 7 + R2 1) / 10 fixed MED (R1 8 + R2 2) / LOW+INFO plus 3 rebutted pre-existing and 3 calibration skips |
| unknown | `REVIEW_38.md` | Claude Code CLI v2.1.112 EnterWorktree builtin stale-base bug: `EnterWorktree(n… | 6 fixed HIGH + 3 fixed MED/LOW + 1 rebutted + 1 unknown INFO + lead document-only decision |
| unknown | `REVIEW_39.md` | `hand_off_session` without `team_name` still rendered teammate badge because sp… | 1 fixed HIGH main bug + 1 fixed HIGH race + 1 fixed HIGH follow-up + 2 fixed MED + R2 LOW/INFO fixes |
| unknown | `REVIEW_40.md` | Codex/Claude adapter architecture symmetry review for sandbox field naming, res… | 2 fixed HIGH in R1 / 6 fixed MED in R1 / 1 LOW in R1 + R2/R3 fix-to-fix items + INFO acknowledgements |
| unknown | `REVIEW_41.md` | cross-adapter-parity plan single-round review; reviewer-claude sandbox failed t… | 3 fixed MED from reviewer-codex + 1 unknown LOW follow-up + 6 rebutted unverified reviewer-claude items due sandbox failure |
| unknown | `REVIEW_42.md` | archive-failure-ux-upthrow caller archive failure UX surfaced through three-rou… | R1 4 HIGH + 5 MED + 2 LOW / R2 1 HIGH + 2 MED + 1 INFO + 2 LOW + 6 INFO unknown / R3 1 MED + 1 unknown agreed follow-up + 1 LOW + 7 INFO unknown |
| unknown | `REVIEW_43.md` | archive-toctou-fix closed K3/baton archive helper TOCTOU, added reasonKind `pro… | R1 4 agreed true issues + 1 rebuttal-round HIGH unarchive fixed / R2 1 MED + 1 LOW fixed + deferrals and INFO acknowledgements |
| unknown | `REVIEW_44.md` | archive-plan content overwrite fix: post-ff-merge invariant carry-forward and c… | R1 2 HIGH + 1 MED + INFO unknown / R2 1 MED + 2 INFO fixed / R3 1 MED + 1 LOW + 2 INFO fixed / R4 1 LOW fixed polish, total 2 HIGH + 3 MED + 2 LOW + 7 INFO fixed except scoped INFO |
| unknown | `REVIEW_45.md` | Window-size shortcut toggle review for CHANGELOG_124 across 4 rounds; fixed off… | R1 1 HIGH + 4 MED + 2 LOW + 2 INFO + product call + unverified / R2 2 MED + 2 LOW + INFO + follow-up / R3 1 MED + 1 LOW + 2 INFO / R4 0 findings |
| unknown | `REVIEW_46.md` | Prompt-asset cleanup under user CLAUDE constraints plus physical deletion of de… | 0 HIGH + 1 MED fixed + 1 MED rebutted + 3 MED unknown follow-up + multiple INFO follow-up |
| unknown | `REVIEW_47.md` | `deep-review-batch-a1-b-fixes-20260519` plan review and fix closure: 6 HIGH + 1… | R1+R2 6 HIGH fixed + 11 MED fixed / R3 5 HIGH + 9 MED + many LOW/INFO follow-up / total 17 inline fixes + 17 follow-ups |
| unknown | `REVIEW_48.md` | `deep-review-batch-a1-b-followup-r3-20260519` full follow-up for 5 HIGH + 9 MED… | R3 verify 4 true HIGH + 6 true MED + 2 LOW/INFO all landed / 22 commits total / 5 plan-review rounds converged |
| unknown | `REVIEW_49.md` | deep-review-trio-20260521 focused on functional bugs, architecture, and prompt … | R1 6 fixed + 1 rebutted + 5 unknown / R2 4 fixed / R3 6 fixed + upgraded MED + unknown retained / task tool bug fixed / total 17 fixes + 9 follow-ups |
| 2026-05-21 | `REVIEW_50.md` | User report "spawn codex cli session display issue": codex thread-loop missed `… | 1 HIGH + 1 MED + 1 LOW (existing split-brain confirmed) + 4 unknown follow-up |
| 2026-05-21 | `REVIEW_51.md` | Prompt asset slimming follow-up adversarial review over 8 files and 253-line di… | 2 HIGH + 1 MED + 1 unverified + many LOW/INFO + 0 rebutted |
| 2026-05-21 | `REVIEW_52.md` | User-reported codex SessionDetail UX bugs: duplicate ActivityFeed tool calls, t… | 2 HIGH dual-independent + 2 HIGH single-party + 2 MED single/dual + 1 LOW + 6 INFO evidence + 3 rebutted / 6 fixes landed + F4 risk acknowledged |
| 2026-05-24 | `REVIEW_53.md` | Deep review of CHANGELOG_146 task-mcp merge into agent-deck-mcp namespace (~700… | 0 HIGH + 2 MED single-party fixed + 4 LOW (2 dual-independent + 2 single-party) + 5 unknown INFO acknowledged + 1 rebuttal / 6 fixes landed |
| 2026-05-25 | `REVIEW_54.md` | User report codex SessionDetail still duplicated and not expandable; post-hoc r… | 4 fixed HIGH/MED main fixes + 4 adversarial hardening items + 1 FTS trigger risk revision + 0 rebutted |
| 2026-05-25 | `REVIEW_55.md` | Long-lived prompt assets full adversarial review under 7 user CLAUDE constraint… | 0 HIGH + 11 MED + 12 LOW + 1 INFO compliance boundary retained + 1 unverified rebutted |
| 2026-05-26 | `REVIEW_56.md` | Deep code review of main-process files changed in the last 3 months, Batch A/B/… | 3 HIGH + 15 MED + 6 LOW + 1 INFO opportunistic fix + 21 follow-up tracking |
| 2026-05-26 | `REVIEW_57.md` | REVIEW_56 follow-up closure for F2-F21 (excluding completed F1/F10) through Pha… | 0 HIGH + 9 fix + 2 close + 8 dismiss = 19 F items + 3 unnumbered (2 fix + 1 close) + 2 monitor backlog items |
| 2026-05-27 | `REVIEW_58.md` | User screenshot bug: message sent during resume / SDK disconnect recovery did n… | 1 HIGH + 2 MED fixed + 1 rebutted + 6 INFO |
| unknown | `REVIEW_59.md` | Deep-Review Batch A for agent-deck-mcp core tool handlers: `archive-plan-impl.t… | 2 HIGH + 8 MED fixed required + 3 LOW/INFO unknown not fixed + 1 rebutted then downgraded |
| unknown | `REVIEW_60.md` | Deep-Review Batch B for dual sdk-bridge files: claude/codex `index.ts` plus bot… | 1 HIGH + 3 MED fixed required + 2 test gaps + 1 INFO/LOW + 1 unverified follow-up |
| unknown | `REVIEW_61.md` | Deep-Review Batch C over remaining 7 files: task-repo, session manager, main in… | 0 HIGH + 2 MED fixed + 3 LOW fixed + R2 1 LOW fixed + R2 2 tests fixed + 5 rebutted to INFO + file-split candidate |
| unknown | `REVIEW_62.md` | Prompt asset review of 9 assets in deep-review mixed mode; fixed mirrored Claud… | 2 HIGH rebutted to MED and fixed + 13 R1 required fixes + 4 R2 required fixes + 4 INFO accepted + 0 residual |
| unknown | `REVIEW_63.md` | Architecture rationality review after Phase 4 splits for plan `deep-project-rev… | 0 HIGH + 0 MED + 3 LOW left as follow-up + 5 INFO + 4 monitored modules |
| unknown | `REVIEW_64.md` | PlantUML SSOT drift review for 17 `.puml` files plus 2 INDEX files across archi… | R1: 6 HIGH fixed + 11 MED fixed + 6 LOW/INFO fixed + 4 unknown + 1 rebutted / R2: 1 HIGH + 2 MED + 1 INFO fixed / R3: 0 new findings |
| 2026-05-29 | `REVIEW_65.md` | SessionList 3+ level spawn-link tree-render bug: lead spawns A and A spawns B b… | 1 HIGH fixed + 2 LOW fixed + 1 LOW jsdoc ref fixed + 2 INFO fixed + 1 UNVERIFIED resolved |
| unknown | `REVIEW_66.md` | Historical sessions "disappeared" event: `app.setName('Agent Deck')` changed `a… | 0 data loss fixed + 1 data migration pending user quit/replace + 2 residual risks |
| unknown | `REVIEW_67.md` | Issues panel UI token failure plus GVM `cd` override pollution: invalid Tailwin… | 2 HIGH fixed (token failure / gvm cd) + 1 LOW fixed (logs buttons) |
| unknown | `REVIEW_68.md` | Recent major-change deep review batch 1: issue-tracker-mcp, runtime logging, an… | b1: 1 HIGH fixed + 1 MED fixed + 4 LOW fixed (LOW-4 reverted/downgraded) + 6 INFO; b2: 3 MED fixed + 2 LOW fixed + 2 INFO; b3: 1 HIGH fixed + 1 MED fixed + 1 INFO |
| unknown | `REVIEW_69.md` | codex-sdk 0.135 regression plus Issue UI draft-sync review; fixed packaged code… | 1 HIGH fixed + 2 MED fixed + 1 MED reported as issue + 1 LOW fixed + 1 INFO left for decision |
| unknown | `REVIEW_70.md` | issue-tracker draft state machine plus codex sdk-bridge win32 multiplatform rev… | Batch A: 3 HIGH fixed + 4 MED fixed + 1 LOW fixed + 3 INFO; Batch B: 1 HIGH fixed + 1 MED fixed + 1 LOW fixed |
| unknown | `REVIEW_71.md` | Project-wide deep review Batch A1 for MCP hand-off orchestration: 7 files ~2000… | 1 HIGH fixed + 1 MED fixed + 1 INFO fixed + 3 follow-up items (1 MED verified design decision + 2 LOW) |
| unknown | `REVIEW_72.md` | Project-wide deep review Batch A2 for MCP worktree handlers; unified mainRepo r… | 2 MED fixed + 1 LOW fixed + 2 LOW follow-ups |
| unknown | `REVIEW_73.md` | Project-wide deep review Batch B1 for archive_plan transaction core; late post-… | 2 MED fixed + 1 LOW fixed + 2 LOW follow-ups |
| unknown | `REVIEW_74.md` | Project-wide deep review Batch B2 for archive_plan helper layer; fixed post-com… | 1 HIGH fixed + 1 MED fixed + 1 INFO fixed + 1 INFO follow-up |
| unknown | `REVIEW_75.md` | Project-wide deep review Batch C1 for claude-code sdk-bridge entry, create-sess… | 1 HIGH fixed + 2 MED fixed + 5 INFO fixed |
| unknown | `REVIEW_76.md` | Project-wide deep review Batch C2 for claude-code sdk-bridge recoverer; fixed c… | 2 MED fixed + 1 INFO fixed + 2 INFO by-design |
| unknown | `REVIEW_77.md` | Project-wide deep review Batch C3 for claude-code sdk-bridge stream, translate,… | 0 HIGH / 0 MED; 3 INFO fixed + 1 LOW rebutted as intentional design, comment clarified |
| unknown | `REVIEW_78.md` | Project-wide deep review Batch C4 for claude-code sdk-bridge permission/tool/re… | 1 MED fixed + 1 LOW fixed defensively + 3 comments fixed + 1 LOW follow-up + 2 INFO by-design |
| unknown | `REVIEW_79.md` | Project-wide deep review Batch D1 for codex-cli sdk-bridge create-session and e… | 2 MED fixed + 4 INFO fixed |
| unknown | `REVIEW_80.md` | Project-wide deep review Batch D2 for codex-cli sdk-bridge thread-loop, transla… | 1 MED fixed + 1 LOW fixed + 1 INFO fixed + 2 follow-ups (claude parity MED + unverified double-finished) |
| unknown | `REVIEW_81.md` | Project-wide deep review Batch D3 for codex-cli sdk-bridge recoverer; fixed clo… | 2 MED fixed + 1 LOW unknown not changed |
| unknown | `REVIEW_82.md` | Project-wide deep review Batch D4 for codex-cli binary, instance pool, adapter … | 1 MED fixed + 1 MED rebutted + 1 LOW unknown + 3 INFO fixed + 3 follow-ups |
| unknown | `REVIEW_83.md` | Project-wide deep review Batch E1 for session manager core subsystem; fixed clo… | 1 HIGH fixed + 2 MED fixed + 6 INFO (by-design, already fixed, split correctness) |
| unknown | `REVIEW_84.md` | Project-wide deep review Batch E2 for scheduler and summarizer subsystem; fixed… | 3 LOW fixed + 4 INFO, including 2 follow-ups |
| unknown | `REVIEW_85.md` | Project-wide deep review Batch F1 for MCP spawn_session and recursion guards; f… | 4 MED fixed + 2 LOW fixed + 1 MED to follow-up + 2 INFO |
| unknown | `REVIEW_86.md` | Project-wide deep review Batch F2 for send and universal-message-watcher dispat… | 3 MED fixed + 3 LOW fixed + 1 INFO + 1 unverified |
| unknown | `REVIEW_87.md` | Project-wide deep review Batch F3 for task handlers and team-scope permissions;… | 1 MED fixed + 3 LOW fixed + 2 INFO test gaps |
| unknown | `REVIEW_88.md` | Project-wide deep review Batch G1 for session-repo persistence; fixed rename sp… | 1 MED fixed + 3 LOW fixed + 1 INFO (cli_session_id downgraded) |
| unknown | `REVIEW_89.md` | Project-wide deep review Batch G2 for team-repo persistence and Follow-up #9 cl… | 4 LOW fixed (3 test fixes + 1 source fix) + 2 INFO |
| unknown | `REVIEW_90.md` | 全项目 deep review 批 G3：agent-deck-message-repo 持久层 | Unspecified (legacy; see review) |
| unknown | `REVIEW_91.md` | 全项目 deep review 批 G4：杂项 store（event/file-change/summary/image-uploads/payload-t… | Unspecified (legacy; see review) |
| unknown | `REVIEW_92.md` | Project-wide deep review Batch G5 for settings-store; fixed value-uplift migrat… | 1 MED fixed + 1 LOW fixed + 1 LOW/INFO fixed + 2 INFO fixed |
| unknown | `REVIEW_93.md` | 全项目 deep review 批 H1：renderer issue 组件（Batch H 开篇） | Unspecified (legacy; see review) |
| unknown | `REVIEW_94.md` | 全项目 deep review 批 H2：renderer core（App + session-store） | Unspecified (legacy; see review) |
| unknown | `REVIEW_95.md` | Project-wide deep review Batch H3 for SessionDetail subsystem; fixed cancel toa… | 3 MED fixed + 5 LOW fixed + 2 INFO fixed |
| unknown | `REVIEW_96.md` | deep-review-project follow-up cleanup of 11 deterministic items across MCP hand… | 1 MED fixed + 5 LOW fixed + 4 INFO fixed |
| unknown | `REVIEW_97.md` | SQLite 单测「真跑不 skip」+ 修 4 失败文件 | Unspecified (legacy; see review) |
| unknown | `REVIEW_98.md` | simple-review log+asset hardening: fd-based LogsReadToday with O_NOFOLLOW, Mona… | 0 HIGH / 2 MED + 2 INFO/LOW all fixed / a11y INFO follow-up |
| unknown | `REVIEW_99.md` | resume-history feature first code deep-review over commits 0d94640 to 7a5c75; f… | R1 3 fixes + R2 1 HIGH+1 LOW + R3/R4 1 HIGH+1 MED cancellation-epoch + 2 lead increments / 1 INFO follow-up |
| unknown | `REVIEW_100.md` | teamless-dm feature plus universal-message-watcher cross-adapter dispatch engin… | R1 1 LOW + R2 1 LOW, both fixed / 1 LOW + 4 INFO follow-up on retention/capacity |
| unknown | `REVIEW_101.md` | codex-cli sdk-bridge disconnect recovery, restart, and rollback sequencing revi… | R1 1 HIGH-to-MED + 3 MED merged + R2 2 INFO hardening / follow-up: issue 30ca35a9 network-dirs, restart fallback handoffPrompt bubble, claude restart cancel-guard parity, and 3 R1 INFO |
| unknown | `REVIEW_102.md` | 图片附件子系统 deep-review（R1+R2 双轮异构对抗收口） | Unspecified (legacy; see review) |
| unknown | `REVIEW_103.md` | floating-window subsystem deep-review over 6 files; fixed fold-to-toggle custom… | 1 MED fixed + 6 LOW fixed + 6 INFO fixed + D-1 rebutted/not deleted |
| unknown | `REVIEW_104.md` | main-process startup/shutdown index facade review; fixed before-quit reentry pr… | 4 MED fixed + 1 LOW fixed + 1 INFO fixed (8 new tests) + 3 INFO documented / follow-up items accepted |
| unknown | `REVIEW_105.md` | adapter spawn-options builder and registry deep-review; fixed resumeCliSid/resu… | 2 MED fixed + R2 1 LOW fixed + 2 INFO fixed + field guard (c) / follow-up envOverrideExtra bridge placement and optional initAll UI surface |
| unknown | `REVIEW_106.md` | task-repo persistence deep-review for CRUD/delete/handoff/list/_deps; fixed sam… | 1 MED fixed + 2 LOW fixed + 2 INFO fixed + 3 INFO retained + 1 INFO defensible / follow-up cleanupBlocksReferences O(N), bare list TEMP B-TREE, and non-ASCII case-insensitive search |
| unknown | `REVIEW_107.md` | renderer settings/TeamDetail UI cluster deep-review Batch 9; adversarial review… | 1 MED-D fixed + 2 LOW fixed + 1 INFO fixed + dead component deleted / R1 2 MED invalidated by component deletion / follow-up transport-specific field validation and jsdom component tests |
| unknown | `REVIEW_108.md` | `ipc/adapters.ts` main logic simple-review Batch 10 closeout for 9c67c120 style… | 2 MED fixed (merged) + 2 LOW fixed (merged) / follow-up handler-level tests and remaining 9c67c120 preload/api thin wrappers |
| unknown | `REVIEW_109.md` | preload/api remaining 5 thin-wrapper contract simple-review Batch 11; 8 validat… | 0 true fixes / 1 INFO follow-up for global CHANGELOG_<X> drift / follow-up 9c67c120 closed, Signal 1 shutdown race, and preload/api handler tests |
| 2026-06-02 | `REVIEW_110.md` | shutdown race simple-review: after closeDb, adapter tail events hit ingest to g… | 1 MED fixed + 1 LOW fixed (merged) + 1 INFO recorded / follow-up summarizer/scheduler in-flight getDb guarded by try/catch |
| unknown | `REVIEW_111.md` | image attachment hook async race committed regression tests for REVIEW_102 foll… | 1 MED fixed (false-green made honest) + 2 INFO test hardening fixed + R2 1 INFO fixed / follow-up wider image branch coverage and thumbnail full fix |
| unknown | `REVIEW_112.md` | universal-message dispatch plus prompt assets deep-review; fixed stop-during-de… | R1 2 MED fixed + 2 LOW fixed + 1 INFO fixed / R2 1 LOW fixed + 2 INFO fixed / R3 0 |
| unknown | `REVIEW_113.md` | spawn_session permission and sandbox override field descriptions; user asked no… | 1 MED fixed + 1 INFO |
| unknown | `REVIEW_114.md` | reviewer-claude missing `send_message` and issue adapter memory: custom agent f… | 1 MED fixed + 1 LOW fixed |
| unknown | `REVIEW_115.md` | Data tab opened macOS permission prompt; kept automatic reads but no longer sta… | 1 MED fixed |
| unknown | `REVIEW_116.md` | Login item duplicate registration on startup; startup and settings hot-update n… | 1 MED fixed + 1 LOW fixed |
| unknown | `REVIEW_117.md` | `hand_off_session` source session continuation was blocked by the recentlyDelet… | 1 MED fixed + 1 LOW fixed |
| unknown | `REVIEW_118.md` | `hand_off_session` caller close now keeps post-handoff tail output visible by s… | 1 MED fixed + 1 LOW fixed |
| unknown | `REVIEW_119.md` | Standalone `spawn_session` children lacked first-reply anchors and immediate tr… | 1 MED fixed + 2 LOW fixed |
| unknown | `REVIEW_120.md` | `hand_off_session` treated archived team memberships as fatal transfer failures. | 1 MED fixed + 1 LOW fixed |
| unknown | `REVIEW_121.md` | Row-active and operational active-team membership semantics were collapsed into… | 1 MED fixed + 2 LOW fixed |
| unknown | `REVIEW_122.md` | Codex file-change reporting showed incomplete or no-op patch records. | 2 MED fixed + 1 LOW guarded |
| unknown | `REVIEW_123.md` | SessionDetail permissions tab showed Claude settings for Codex sessions. | 2 MED fixed + 1 LOW guarded |
| unknown | `REVIEW_124.md` | Pending AskUserQuestion and Plan rows had duplicate lower-right actions. | 2 LOW fixed |
| unknown | `REVIEW_125.md` | Claude compaction display and adapter-aware thinking copy. | 3 LOW fixed |
| unknown | `REVIEW_126.md` | Runtime log warning/error triage follow-up. | 2 LOW fixed |
| unknown | `REVIEW_127.md` | Latest commit lockfile drift plus Codex internal-hook filtering and lifecycle g… | 2 MEDIUM fixed / 1 guarded |
| unknown | `REVIEW_128.md` | Codex quota reads without an open Codex session recreated app-server processes … | 1 MEDIUM fixed |
| unknown | `REVIEW_129.md` | Real-time token-rate display split Claude alias and actual model buckets. | 1 MEDIUM fixed + 1 LOW fixed |
| unknown | `REVIEW_130.md` | Directory picker stalls, provider quota refresh cadence, and Codex create-sessi… | 3 MEDIUM fixed + 1 LOW fixed |
| unknown | `REVIEW_131.md` | Recent warning/error app log triage: Monaco CDN worker failure and Codex quota … | 2 MEDIUM fixed |
| unknown | `REVIEW_132.md` | Codex-only simple review of directory picker/quota/log/Codex temp-session chang… | 2 HIGH fixed |
| unknown | `REVIEW_133.md` | Provider quota cadence moved to 10 minutes and Codex MCP spawn now returns a st… | 1 HIGH fixed + 1 LOW fixed |
| unknown | `REVIEW_134.md` | Claude restart jsonl precheck raced old SDK stream cleanup. | 1 MEDIUM fixed + 1 LOW fixed |
| unknown | `REVIEW_135.md` | Provider quota window could show stale snapshots from out-of-order refreshes. | 2 MEDIUM fixed |
| unknown | `REVIEW_136.md` | Claude UI create waited for SDK first id before returning. | 1 HIGH fixed + 2 MEDIUM fixed |
| unknown | `REVIEW_137.md` | Claude restart phantom runtime ids could still fresh-fallback when applicationS… | 1 MEDIUM fixed |
| unknown | `REVIEW_138.md` | Diff walkthrough presentation contract prompt-asset review. | 2 LOW fixed + 2 INFO accepted |
| unknown | `REVIEW_139.md` | Runtime log triage for Codex quota auth failures and SDK orphan-hook noise. | 3 LOW fixed + 2 non-fixes documented |
| unknown | `REVIEW_140.md` | Behavior-preserving large-file split across schemas, spawn, store, Codex app-se… | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW + 3 INFO accepted |
| unknown | `REVIEW_141.md` | Diff panel bottom clipping plus Claude/Codex dependency bump. | 0 CRITICAL / 0 HIGH / 0 MEDIUM / 1 LOW fixed |
| unknown | `REVIEW_142.md` | `send_message` rejected valid target session aliases before authorization. | 1 HIGH fixed |
| unknown | `REVIEW_143.md` | Model slug collisions and Codex/Claude runtime metadata calibration. | 3 MEDIUM + 2 LOW fixed / 2 residual LOW documented |
