---
plan_id: followup-cleanup-20260601
created_at: 2026-06-01T13:02:00+08:00
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/followup-cleanup-20260601
status: completed
base_commit: 0eb0400dc278aa9f107034c289a88370112c497b
base_branch: main
final_commit: 2febca86500103d12c898f40f89db8900c9a670b
completed_at: 2026-06-01T14:30:00+08:00
---

# Follow-up 清理 plan（deep-review-project 遗留 11 条）

## Context

deep-review-project-20260531 plan 已收口归档（A-H / REVIEW_71-95）。归档 plan §Follow-up 汇总 15 条「留用户决策」。用户拍板：**#13（FTS 大小写敏感性，需 rebuild + 搜索语义变更）+ #15（issue same-ms updatedAt，需 repo schema 单调 revision）不做**；**#9 实际已在 G2/REVIEW_89 闭环**（Follow-up 列表漏划）。**其余 11 条全修**。

这批全是 review 已定论、修法方向明确的确定性修复（非新 design），不需 RFC/spike/对抗 review。但跨 ~11 文件触动核心 MCP handlers / archive-plan / worktree / scheduler / message-repo / image-uploads + tests → 走 worktree 隔离 + plan 跟踪。

## 工作流

worktree 隔离（plan-id `followup-cleanup-20260601`，base main HEAD `0eb0400`）。每完成一组 commit 一次（按风险域分组）。收尾 typecheck 双配置 + 相关 vitest + 写 REVIEW_96（这批是 debug/加固性质，归 reviews 非 changelog）。**不走多轮对抗 review**（review 已定论）；改完每条自检 + 跑测。

## 修复清单（按风险域分 4 组）

### Group A — MCP hand-off handler（3 条，src/main/agent-deck-mcp/tools/handlers/hand-off-session/）

- **#1 [MED, design 取舍] partial adopt 失败 teammate 泄漏** — `team-adopt-coordinator.ts` firstTeam swapLead 失败时 fatal abort（close newSid + return error），但 caller 在**其他 team** 的 teammate 既没被新 session 接管也没被 shutdown → 孤儿。
  - **方案（已确认 方案1）**：firstTeam fatal abort 路径在 close newSid + return error **之前**，对 caller 名下所有 team 的 teammate 跑一次 baton-cleanup phase-1 式 shutdown（team-scoped），避免孤儿。复用 `runBatonCleanup` / `shutdownTeammatesOnBaton` helper（baton-cleanup.ts）。
- **#2 [LOW] sessionRepo.get 重复反查** — `cwd-resolver.ts` `resolveCallerCwdDeps`(L57) + `resolveCallerSessionCwd`(L128) 对同一 callerSessionId 各反查一次。handler-main.ts L102 mergeCallerCwd + L121 resolveCallerSessionCwd 两次落 DB。
  - 修法：handler-main 反查一次 sessionRepo.get(callerSessionId) → 把 row 透传给两个 resolver（加可选 `prefetchedRow` 参数），避免二次查询。保持 external sentinel 短路语义。
- **#3 [LOW] 显式 args.cwd 无 existsSync 预检** — `handler-main.ts:161` `finalCwd = args.cwd ?? defaultCwd`，args.cwd 覆盖路径无 existsSync（generic 模式 callerSessionCwd 有 precheck，args.cwd 漏）。
  - 修法：args.cwd 显式传入时加 existsSync precheck（复用 handlerDeps?.cwdExists ?? existsSync），失效路径 return err 清晰提示（而非 spawn 时 chdir 失败）。

### Group B — MCP worktree handlers（2 条）

- **#4 [LOW] enter_worktree marker 写失败不回滚已建 worktree** — `enter-worktree-impl.ts:325-342` Step 7 git worktree add 成功后 Step 8 setCwdReleaseMarker 失败直接 return error，留 orphan worktree。
  - 修法：marker 写失败时 best-effort 回滚已建 worktree（`git worktree remove --force` + `branch -D`），回滚失败则 warn 并在 error hint 里说明需手动清。jsdoc L26「不做部分回滚（git 操作不可逆）」改为「git 操作可逆但代价高，marker 写失败回滚已建 worktree 防 orphan」。
- **#5 [LOW] exit_worktree realpath fallback 尾斜杠归一化** — `exit-worktree-impl.ts:144-168` realpath 后 `argReal !== markerReal` 字面比较，尾斜杠差异（`/path/` vs `/path`）误报 cross-worktree reject。
  - 修法：比较前对 argReal/markerReal 去尾斜杠归一化（`replace(/\/+$/,'')`）。对齐 schema worktreePathOverride describe 加尾斜杠说明。

### Group C — MCP archive-plan（2 条）

- **#6 [LOW] worktree remove 不带 --force** — `archive-plan/impl-cleanup.ts:231-239` `git worktree remove` 不带 --force，precheck→实删窗口被写脏会失败，hint 反而建议 --force（实现与文案不一致）。
  - 修法：`git worktree remove --force`（precheck 已验 clean，--force 兜底 race window 写脏；与 hint 文案一致 + 与中止流程手动命令对齐）。
- **#7 [LOW] cwd-resolver 重复** — hand-off-session/cwd-resolver.ts 的 caller cwd 反查 + fallback 逻辑 vs archive-plan-impl.ts 内联 cwd 解析重复。
  - 修法：抽 `_shared/caller-cwd-resolver.ts`（sessionRepo.get + external sentinel 短路 + fallback 链），hand-off 与 archive-plan 共用。**注意与 #2 协同**（#2 改 hand-off cwd-resolver 时一并考虑抽 shared）。
- **#8 [INFO] INDEX 概要列 fallback 到 plan_id** — `impl-archive-fs.ts:148` `freshFm.description ?? freshFm.plan_id ?? input.planId`，plan 无 description 字段恒 fallback planId（概要列无价值）。
  - 修法：fallback 链加「读 plan §总目标/§Context 首行非空文本」作为 description（正则提取首个 `## ` section 下首行）；仍无则 fallback planId。功能增强非 bug。

### Group D — scheduler / message-repo / image-uploads / tests（4 条）

- **#11 [LOW] issue GC 续删节奏** — `issue-lifecycle-scheduler.ts` 6h tick × 500，用户调短 retention 想快速清积压偏慢。
  - 修法：单轮 scan 若删满 limit（=还有积压）→ 调度一个短延迟（如 30s）的额外 tick 续删，直到某轮删 < limit；常态仍 6h。不改默认 tick 频率，只加「积压未清完时加速续删」。
- **#10 [INFO, 测试网] hand-off.test.ts:170 占位断言** — `expect(true).toBe(true)` 假覆盖 timeout 路径。
  - 修法：给 `race-with-timeout.ts` `raceWithTimeout` 写**真单测**（新建 `oneshot-llm/__tests__/race-with-timeout.test.ts`）：真实短 timeout（work 用 never-resolve / 慢 promise）验 timer 先赢 reject errorMessage + onTimeout 被调 + timeoutMs<=0 直接 return work + work 先赢正常返回 + finally clearTimeout。纯 promise 无 SDK 无 fake-timer brittle。原 placeholder 改注释指向新单测。
- **#12 [INFO, 测试网] findEligibleExcludingTargets repo 层无 unit test** — `agent-deck-message-repo/dispatch.ts:50-78` 空数组 fallback（不拼 NOT IN ()）/ NOT IN 排除 仅集成层覆盖。
  - 修法：`agent-deck-message-repo.test.ts` 加 repo 层 unit test（SQLite 真测，按 plan 约定 binding rebuild 流程）：空 excludeTargets → 退化 findEligible / 非空 → NOT IN 正确排除 + FIFO（sent_at ASC, rowid ASC）。**SQLite 真测需 binding rebuild + 还原**（plan §当前进度 binding 流程）。
- **#14 [INFO] image-uploads base64 length cap 假设无换行** — `image-uploads.ts:75` cap `ceil(MAX*4/3)+4` 隐含假设无换行 base64。当前不可达（browser btoa/FileReader 不产换行），仅备忘。
  - 修法：**仅加注释**说明假设前提 + 若未来 renderer 改 MIME-formatted base64 需放宽 cap（含换行字节）。不改逻辑（当前正确）。

## 决策点（已确认）

#1（归档 plan 明示「design 取舍」）→ **用户选方案1**：firstTeam fatal abort 前对 caller 全 team teammate 跑 team-scoped shutdown（复用 baton-cleanup helper），失败=彻底回退不留孤儿。

## 验证

- 每组改完：`zsh -i -l -c "pnpm typecheck"`（双配置）。
- Group A/B/C：`node_modules/.bin/vitest run src/main/agent-deck-mcp/`（hand-off / archive-plan / worktree handler 单测）。
- Group D #10：`vitest run src/main/session/oneshot-llm/__tests__/race-with-timeout.test.ts`（新建）。
- Group D #12：SQLite 真测走 binding rebuild 流程（nvm use 20.18.3 + prebuild-install --target 20.18.3 → 跑 `agent-deck-message-repo.test.ts` → **务必还原 Electron binding**）。
- Group D #11：scheduler 单测加「删满 limit → 续删 tick」fake-timer 或注入 tick 计数验证。
- 全部完成：全项目 `node_modules/.bin/vitest run` 绿 + typecheck 双配置绿。
- 每个 bug fix 配回归 test（#14 纯注释除外），temp-revert 验非空。
- 收尾：写 REVIEW_96（这批归 reviews）+ 更新 ref/reviews/INDEX.md + archive_plan 归档本 plan。

## 当前进度

- [x] worktree 建好（base 0eb0400，HEAD 校验匹配）
- [x] Group A #1/#2/#3 — commit 35c403b（#7 一并）
- [x] Group B #4/#5 — commit 5ab5558
- [x] Group C #6/#7/#8 — commit feb05d3
- [x] Group D #11/#10/#12/#14 — commit d9dbf38
- [x] 收尾 typecheck（双配置绿）+ vitest（全项目 1292 passed / 216 skipped）+ REVIEW_96 + INDEX
- [ ] archive_plan 归档本 plan

#12 SQLite 真测已 Node 20 ABI-115 跑 22/22 绿 + 还原 Electron ABI-130 binding byte-identical。
全项目 3 个 session-repo 相关 SQLite 测试失败为**预存**（clean main 0eb0400 同样 7 fail），与本批无关。

binding 流程备忘（#12 SQLite 真测后必还原）：
```
rm -f ~/.npm/_prebuilds/*better-sqlite3*
rm -rf node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build
zsh -i -l -c "pnpm postinstall"
```

## 下一会话第一步

进 worktree `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/followup-cleanup-20260601`，按 Group A→D 顺序实施。所有代码路径用 worktree 内绝对路径。

## 关键文件

- `src/main/agent-deck-mcp/tools/handlers/hand-off-session/{handler-main,cwd-resolver,team-adopt-coordinator}.ts`（#1/#2/#3/#7）
- `src/main/agent-deck-mcp/tools/handlers/{enter-worktree-impl,exit-worktree-impl}.ts`（#4/#5）
- `src/main/agent-deck-mcp/tools/handlers/archive-plan/{impl-cleanup,impl-archive-fs}.ts`（#6/#8）
- `src/main/agent-deck-mcp/tools/handlers/_shared/caller-cwd-resolver.ts`（#7 新建）
- `src/main/store/issue-lifecycle-scheduler.ts`（#11）
- `src/main/session/oneshot-llm/{race-with-timeout.ts,__tests__/race-with-timeout.test.ts}`（#10）
- `src/main/store/agent-deck-message-repo/dispatch.ts` + `__tests__/agent-deck-message-repo.test.ts`（#12）
- `src/main/store/image-uploads.ts`（#14 注释）
- schemas（#5 exit worktree describe）
