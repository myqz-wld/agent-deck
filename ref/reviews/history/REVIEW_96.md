# REVIEW_96 — deep-review-project Follow-up 清理 11 条（MCP handlers / archive-plan / worktree / scheduler / message-repo / image-uploads + 测试网）

- 日期: 2026-06-01
- 类型: Debug / 加固（孤儿 teammate 泄漏修复 + 重复 DB 反查消除 + cwd 预检 + worktree orphan 回滚 + 尾斜杠归一化 + worktree remove --force + 共享 resolver 抽离 + INDEX 概要列增强 + GC 续删节奏 + 测试网补全）
- 触发: 用户「清理 deep-review-project 遗留 follow-up」授权（plan followup-cleanup-20260601）
- 关联: plan followup-cleanup-20260601（已归档）/ deep-review-project-20260531（REVIEW_71-95 来源）/ REVIEW_71（adopt firstTeam fatal abort #1 来源）/ REVIEW_56 §F9（caller cwd resolver #2/#7 来源）/ REVIEW_36 HIGH-3（hand-off cwd default #3 上下文）/ REVIEW_83 LOW（issue GC limit #11 上下文）/ REVIEW_90 R2 MED（message-repo FIFO #12 上下文）/ REVIEW_91（image-uploads cap #14 来源）/ CHANGELOG_169 F4（baton-cleanup #1 helper）
- 方法: **非多轮对抗 review** —— 这批是 deep-review-project（REVIEW_71-95）已定论、修法方向明确的确定性修复（11 条全部源自先前对抗 review 的 finding / Follow-up 列表），plan 阶段已确认无新 design。本轮按风险域分 4 组实施 + 每条配回归 test（#14 纯注释除外）+ typecheck 双配置 + 相关 vitest（含 #12 SQLite binding rebuild 真测）+ 全项目 vitest 绿。**#1 design 取舍**（fatal abort 是否牵连 teammate）由用户 plan 阶段拍板方案 1。
- 收口: 4 组 4 commit（Group A+#7 / Group B / Group C / Group D），全项目 1292 passed + 216 skipped（SQLite-binding-gated）+ typecheck 双配置绿。

## 范围（11 文件 + 测试）

| 风险域 | 文件 | Follow-up |
|---|---|---|
| MCP hand-off handler | `hand-off-session/{handler-main,cwd-resolver,team-adopt-coordinator}.ts` | #1 / #2 / #3 |
| MCP worktree handler | `enter-worktree-impl.ts` / `exit-worktree-impl.ts` + schema | #4 / #5 |
| MCP archive-plan | `archive-plan.ts` / `archive-plan/{impl-cleanup,impl-archive-fs,index-sync-helpers}.ts` / `archive-plan-impl.ts` | #6 / #7 / #8 |
| 共享 resolver | `_shared/caller-cwd-resolver.ts`（新建） | #7 |
| scheduler / repo / uploads | `issue-lifecycle-scheduler.ts` / `agent-deck-message-repo/dispatch.ts`(测试) / `image-uploads.ts` | #11 / #12 / #14 |
| 测试网 | `oneshot-llm/__tests__/race-with-timeout.test.ts`（新建） | #10 |

**不做**（用户 plan 阶段拍板）：#13（FTS 大小写敏感性，需 rebuild + 搜索语义变更）/ #15（issue same-ms updatedAt，需 repo schema 单调 revision）；#9 已在 G2/REVIEW_89 闭环。

## 修复明细

### Group A — MCP hand-off handler

**#1 [MED, design 取舍] partial adopt 失败 teammate 泄漏（team-adopt-coordinator.ts firstTeam fatal abort 路径）**

`runPhase15AdoptSwapLeadLoop` firstTeam swapLead 失败（swapped:false / throws）→ fatal abort 原仅 `close(newSpawnedSid) + return error`。但 caller 在**其他 team** 的 teammate（典型 multi-team caller 的 reviewer-claude / reviewer-codex）既没被新 session 接管（swapLead 没跑到 / firstTeam 失败短路），也没被 shutdown → 孤儿泄漏（占内存 + SDK live query）。
- **用户选方案 1**（plan §决策点）：fatal abort 在 close newSid + return error **之前**，先对 caller 全 team teammate 跑 team-scoped shutdown（复用 `shutdownTeammatesOnBaton`，与 baton-cleanup.ts phase 1 同款 helper / deps seam）。`excludeSessionIds` 含 newSpawnedSid 避免误关即将被 close 的新 session。shutdown 失败仅 warn 不阻塞仍 return error（彻底回退优先，残留 teammate 用户可手动清）。error extras 透传 `teammatesShutdown` 结果。
- caller 此路径状态：自己 active 不变（swapLead transaction 内 precheck 短路 demote 未执行），但牵连的 teammate 被清 → 符合「fatal abort = 整片回退到 hand-off 前干净态（无新 session + 无孤儿 teammate）」语义。
- 回归 test: T6.X3a（swapped:false）/ T6.X3b（throws）更新断言 fatal abort 走 team-scoped shutdown（原断言 `mockShutdown).not.toHaveBeenCalled()` 编码旧 buggy 行为）。

**#2 [LOW] sessionRepo.get 重复反查（handler-main → cwd-resolver 双 resolver）**

`mergeCallerCwd` + `resolveCallerSessionCwd` 对同一 callerSessionId 各反查一次 sessionRepo.get（两次落 DB）。
- 修法: handler-main 一次 `fetchCallerSessionRow` 复用 → `prefetchedRow` 透传给两个 resolver（各加可选参数）。`prefetchedRow !== undefined` 时直接用（含 null 表示已查 caller 不在 sessions 表），`undefined` 时 resolver 自查兜底（保留 test seam / 独立调用）。fail-open warnings 在 prefetch 段一次性 logger.warn。

**#3 [LOW] 显式 args.cwd 无 existsSync 预检（handler-main.ts）**

`finalCwd = args.cwd ?? defaultCwd`，generic 模式 callerSessionCwd 有 precheck（resolveCallerSessionCwd 内 cwdExists）、plan 模式 worktreeExists 走 validatePlanModeWorktreeExists，但 caller 显式传 args.cwd 这条覆盖路径两边都漏检 → 失效路径直接传 spawn 时 chdir ENOENT。
- 修法: args.cwd 显式传入时加 existsSync precheck（复用 `handlerDeps?.cwdExists ?? existsSync` seam），失效路径 return 清晰错误。回归 test +1（args.cwd 不存在 → reject + spawn 未调用）；deny-happy override-test 注入 `cwdExists: () => true`（fixture 传虚构 cwd）。

### Group B — MCP worktree handler

**#4 [LOW] enter_worktree marker 写失败不回滚已建 worktree（enter-worktree-impl.ts step 8）**

git worktree add（step 7）成功后 setCwdReleaseMarker（step 8）失败原仅 return error，留 orphan worktree（marker 没写 → exit_worktree 自动反查不到要操作的 worktree，caller 既看到 error 又留无主 worktree）。
- 修法: marker 写失败 → best-effort 回滚已建 worktree（`git worktree remove --force` + `branch -D`，branch -D 仅在 remove 成功后尝试）。回滚成功 hint「Already rolled back」；回滚失败 hint「Rollback FAILED + 手动清命令」。jsdoc L26「不做部分回滚（git 操作不可逆）」改为「git 可逆但代价高，marker 写失败回滚防 orphan」。回归 test +2（回滚成功 / remove 失败需手动清）。

**#5 [LOW] exit_worktree realpath fallback 尾斜杠误报 cross-worktree（exit-worktree-impl.ts cross-worktree 校验）**

`argReal !== markerReal` 字面比较，realpath fallback 退化字面时一端带尾斜杠（`/path/`）另一端不带（`/path`）→ 误报 cross-worktree reject。
- 修法: 比较前 `stripTrailingSlash` 归一化（`replace(/\/+$/,'')`，保留根 `/`）。schema worktreePath describe 加尾斜杠归一化说明。回归 test +2（尾斜杠不误报 + 真 cross-worktree 归一化后仍 reject）。

### Group C — MCP archive-plan

**#6 [LOW] worktree remove 不带 --force（impl-cleanup.ts step 14）**

precheck 已验 worktree clean，但 precheck→实删窗口被外部写脏时 `git worktree remove`（无 --force）失败，而 hint 反建议 --force（实现与文案矛盾）。
- 修法: `git worktree remove --force`（precheck 已验 clean，--force 兜底 race window；与 hint 文案 + 中止流程手动命令一致）。回归 test 断言更新（impl-core.test.ts gitCalls[10]）。

**#7 [LOW] cwd-resolver 重复（hand-off vs archive-plan）**

hand-off-session/cwd-resolver.ts 与 archive-plan.ts 各写一份「external sentinel 短路 + try/catch fail-open + row null warning + warnings 收集」（REVIEW_56 §F9 引入时即对称复制）。
- 修法: 抽 `_shared/caller-cwd-resolver.ts` 的 `fetchCallerSessionRow`（**纯函数不 logger.warn**，operator log 由各 handler loop warnings 输出），hand-off + archive-plan 共用。两端各自保留 row→deps 映射（hand-off 仅 cwd / archive 含 cwd + cwdReleaseMarker + clearCwdReleaseMarker，字段不同不抽 generic factory）。与 #2 协同（hand-off 端一并支持 prefetchedRow）。

**#8 [INFO] INDEX 概要列 fallback 恒到 plan_id（impl-archive-fs.ts）**

`freshFm.description ?? freshFm.plan_id ?? planId`，plan frontmatter 几乎从不带 description key（用 `## 总目标`/`## Context` 节承载），恒 fallback planId（概要列与文件名列重复无信息量）。
- 修法: fallback 链加中间档「读 plan 正文首个 `## ` section 首行非空文本」（`extractPlanSummaryFromBody` helper，fence 状态机跳过代码块 / 跳过 list/quote/table，只取自然段首行）。新链 `description > section 首行 > plan_id > planId`。helper 经 archive-plan-impl re-export 做 test seam。回归 test +6 helper 单测 +1 集成测试。

### Group D — scheduler / repo / uploads / 测试网

**#11 [LOW] issue GC 续删节奏偏慢（issue-lifecycle-scheduler.ts）**

6h tick × 500/轮，用户调短 retention 想快速清积压时需等 6h × N 轮。
- 修法: 某路 listForGc 删满 limit（=还有积压）+ deletedCount > 0 → 调度短延迟（catchUpDelayMs 默认 30s）续删 tick，直到某轮删 < limit。常态 6h tick 不变。scheduler 显式传 gcBatchLimit（500）；deletedCount=0（全 race/throw）不排续删（防空转死循环）；stop() 清 pending 续删 timer。回归 test +4（删满→续删 / 删<limit 不续删 / deletedCount=0 不续删 / stop 清 timer）。

**#10 [INFO, 测试网] hand-off.test.ts:170 占位断言**

`expect(true).toBe(true)` 假覆盖 timeout 路径（原注释担心 fake-timer + Promise.race 触发 vitest unhandled-rejection 警告）。
- 修法: 给 `raceWithTimeout` 写真单测（新建 `oneshot-llm/__tests__/race-with-timeout.test.ts`）：纯 promise + 真实短 timeout 验 timer 先赢 reject errorMessage + onTimeout / work 先赢正常返回 / timeoutMs<=0 直接 return work / work reject 透传非 timeout error / finally clearTimeout。不碰 SDK / 不碰 fake-timer 故不 brittle。原 placeholder 改注释指向新单测。+7 test。

**#12 [INFO, 测试网] findEligibleExcludingTargets repo 层无 unit test（dispatch.ts:50-78）**

空数组 fallback（不拼 `NOT IN ()`）/ NOT IN 排除仅集成层覆盖。
- 修法: agent-deck-message-repo.test.ts 加 repo 层 SQLite 真单测 +6（空 excludeTargets 退化 findEligible / 单 target NOT IN / 多 target NOT IN / 全排除返 null / 同毫秒 rowid ASC FIFO / 无 pending 返 null）。**SQLite binding rebuild 真测**：nvm use 20.18.3 + prebuild-install --target 20.18.3（ABI-115）→ 跑 22/22 绿（6 新 + 16 原）→ **还原 Electron ABI-130 binding（byte-identical md5 验证）**。

**#14 [INFO] image-uploads base64 cap 假设无换行（image-uploads.ts:75）**

cap `ceil(MAX*4/3)+4` 隐含假设无换行 base64。当前不可达（renderer btoa/FileReader 不产换行）。
- 修法: **仅加注释**说明假设前提 + 若未来 renderer 改 MIME-formatted base64（RFC 2045 每 76 字符插 `\r\n`）需放宽 cap（含换行字节）。逻辑不改（当前正确）。

## 测试与验证

- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）全绿。
- 全项目 vitest（默认 Node 环境）：1292 passed + 216 skipped（SQLite-binding-gated）/ 0 failed / 110 文件。
- #12 SQLite 真测在 Node 20.18.3 ABI-115 下 22/22 绿；验毕**还原 Electron ABI-130 binding byte-identical（md5 64beb2ef045af83e20a5294908f30f70 一致）**，prebuild cache 无污染。
- 每条 bug fix 配回归 test（#14 纯注释除外），新增断言均覆盖修复前后行为差异（#1 T6.X3a/b 断言反转 / #3 #4 #5 #11 新增 case / #8 #10 #12 新 describe）。

## 遗留 follow-up

0（11 条全修；#13/#15 用户拍板不做、#9 已 G2 闭环；本批所有 INFO 已 inline 修复 / 文档化）。
