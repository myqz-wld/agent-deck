# REVIEW_73 — 全项目 deep review 批 B1：archive_plan 事务核心

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第四批）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_71（批 A1）/ REVIEW_72（批 A2）/ commit 826af22 + 08db5e8
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 reviewer pair）+ 交叉反驳轮 + 三态裁决。lead pre-read facade + precheck + ff-merge + cleanup + _impl-shared + 现场 grep 验证。
- 收口: R1 双 reviewer reply（各自单方 finding 无重叠）→ 交叉反驳轮（codex HIGH → claude / claude MED → codex）→ 三态裁决 3 ✅ fix。typecheck 双配置 + agent-deck-mcp 566 passed / 3 skipped（+3 回归 test，1 test 改 unit-test 形态）。

## 范围（批 B1）

archive_plan 多 phase 原子收口事务核心，3 文件 ~970 LOC（+ lead 额外读 archive-fs/cleanup/_impl-shared 评估原子性）：
- src/main/agent-deck-mcp/tools/handlers/archive-plan.ts（handler facade）
- src/main/agent-deck-mcp/tools/handlers/archive-plan/impl-precheck.ts
- src/main/agent-deck-mcp/tools/handlers/archive-plan/impl-ff-merge.ts

> 该子系统经 REVIEW_33/36/56 + 多 plan 多轮历史 review，设计极成熟（precheck 全 fail-fast / post-ff-merge phase 标识 / commit pathspec 隔离 / fresh re-read 防覆盖 / 4 态 cwd dispatch）。

## 三态裁决（3 ✅ 必修）

### ✅ MED post-ff-merge late phase 失败 → handler 短路跳过 baton cleanup → teammate 孤儿
**双方独立提出 ✅**（reviewer-claude MED + reviewer-codex 反驳轮独立判 MED 一致）+ lead 双向 grep 验证。

- **文件**: `archive-plan.ts:222`（修前 `_isArchivePlanError(result) → return err` 在 runBatonCleanup 之前）
- **问题**: archivePlanImpl 对**任何** ArchivePlanError（precheck fail-fast / post-ff-merge 半成品）返回同一 union，handler 一刀切 `return err`，baton cleanup 在其后。post-ff-merge **late phase**（archive commit 已落，仅 git artifacts 清理：git-worktree-remove / git-branch-D / archive-rev-parse-HEAD）失败时 plan 已实质归档完成（caller 使命终结），却跳过 teammate shutdown + archive caller → reviewer teammate 成孤儿 dormant 未 closed。
- **根因关联**: 这是本项目反复踩的「dormant 未 closed」的**另一条进入路径**（archive-plan.ts jsdoc 原只归因于 mainRepo dirty precheck 绕过手工归档，漏了「正常调 tool 但 late phase 失败」）。
- **验证**（lead grep 铁证）：baton 是 handler-only（`grep runBatonCleanup/shutdownTeammates/sessionManager` 在 impl 全家 0 命中，仅 impl-cleanup.ts:167 一条注释提及）；`postFfMergeErr` 给 error 加 `[post-ff-merge:<phase>]` 前缀（_impl-shared.ts:302）→ handler 可据前缀区分。impl-cleanup.ts:172 git commit 成功后才进 late phase。
- **修复**: `_impl-shared.ts` 加 `isPostCommitArchiveError(errorText)` SSOT（POST_COMMIT_PHASES = {archive-rev-parse-HEAD, git-worktree-remove, git-branch-D}，commit 已落的 3 phase）。handler 检测 post-commit error → 仍跑 runBatonCleanup（plan 实质完成 team 该收口）再透传 impl error。早期 post-ff-merge phase（commit 没落，caller 可 reset 重试）**不**触发 baton。回归 test：late phase（git-worktree-remove）失败 → baton 仍调用（对比 precheck dirty 短路不调）。

### ✅ LOW 8c fresh re-read 缺 plan_id/worktree_path 复查（precheck 有，post-ff-merge 缺）
**reviewer-codex 提 HIGH → reviewer-claude 反驳轮 grep 铁证降 LOW** → lead 裁 LOW（cheap defense-in-depth）。

- **文件**: `impl-ff-merge.ts:184`（8c 修前只复查 freshFm.status）
- **问题**: precheck（impl-precheck.ts:390-418）ff-merge 前同时校验 fm.plan_id + fm.worktree_path（CHANGELOG_169 F2 防 silent corruption），但 8c 只复查 status。worktree branch 改 plan_id/worktree_path + 保持 status=in_progress → ff-merge 带进 → 8c 通过 → archive-fs `{...freshFm}` 写到 ref/plans/<input.planId>.md → 归档文件 plan_id 与文件名 stem 脱节。
- **降 LOW 理由**（reviewer-claude grep 铁证）：所有 destructive op（ff-merge 源 worktreeBranch / archivedPath / worktree remove / branch -D / unlink / INDEX key）100% 走 `input.*` + precheck-derived，**零个**读 freshFm.plan_id/worktree_path → 不复现 F2 silent corruption（无误删/错合/错标 completed），仅归档文件**内容字段不一致**（cosmetic）。codex 经类比把 F2 的 HIGH 继承给 8c，类比断裂处：F2 危险源是 input args 驱动破坏，8c 的 freshFm 只驱动内容写入。触发需身份字段被反常编辑（plan 创建即固定，极罕见）。
- **修复**: 8c-id 加 fresh plan_id + worktree_path 复查（与 precheck 对称），漂移 → postFfMergeErr reset 路径。回归 test：fresh plan_id 漂移 → 拒绝 + archive 写/unlink 不发生。

### ✅ MED 8b read-fail / no-frontmatter 失败走 generic hint（应走 reset hint）
**reviewer-codex 单方 + lead 验证**（_impl-shared.ts jsdoc 明确 8b/8c 可干净 reset）→ ✅。

- **文件**: `impl-ff-merge.ts:151`（修前 8b read-fail 不传 phaseHint → 落 generic「按 phase 手工补完」）
- **问题**: _impl-shared.ts:240-241 明确 8b/8c 是**唯一**可 `git reset --hard ORIG_HEAD` 干净回滚的 post-ff-merge phase（无 fs 写入累积）。8c status drift 已传专用 reset hint，但 8b read-fail / no-frontmatter 两条路径不传 phaseHint → 落 generic 误导 caller 走手工补完归档而非先 undo ff-merge。
- **修复**: 8b 两条路径补同级 reset phaseHint（先 reset --hard ORIG_HEAD 再修文件再重调）。副作用：所有 impl postFfMergeErr 调用现都传 phaseHint，无 impl 路径再产生 generic fallback → 「phaseHint 缺省 → GENERIC」test 改为直接 unit-test postFfMergeErr helper（保留契约验证）。

## INFO/follow-up（reviewer-claude 提，留观察 / 低优先）

- **INFO**: baseBranch 解析优先级 / frontmatter↔input cross-check / 4 态 cwd dispatch / mainRepo dirty 精确化 — 逐 focus 点核实全部正确，无 bug（reviewer-claude 详列）。
- **[LOW follow-up] worktree remove 不带 --force**（impl-cleanup.ts:232）— precheck→step14a 窗口 worktree 被外部写脏时失败，hint 自身建议 --force。与 MED 同属「最后一步失败卡住已完成 plan」family。留 follow-up（需权衡 --force 强删 vs 降级 warning）。
- **[LOW follow-up] cwd-resolver 重复**（archive-plan.ts:103-192 vs hand-off-session/cwd-resolver.ts）— 两份 resolveCallerCwdDeps + mergeCallerCwd 近乎逐字重复（fail-open warnings 收集 + 注释互相 cross-ref「对称」）。抽 `_shared/caller-cwd-resolver.ts` 泛型 helper。属重构非正确性。

## 验证

- typecheck: tsconfig.node.json + tsconfig.web.json 均 exit 0
- test: 全量 agent-deck-mcp 35 文件 566 passed / 3 skipped（+3 回归 test：late-phase baton / 8c plan_id drift / 8b reset hint；1 followup test 改 unit-test 形态）
- grep 铁证：baton handler-only（impl 0 命中）；postFfMergeErr [post-ff-merge:<phase>] 前缀可区分；destructive op 全走 input.*（claude 反驳轮验证 8c blast radius）
