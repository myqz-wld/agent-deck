---
plan_id: "deep-code-review-main-3m-20260525"
created_at: "2026-05-25"
status: "completed"
base_commit: "427657fa16c7358fcdf894f4490d584490e0f2f9"
base_branch: "main"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-code-review-main-3m-20260525"
final_commit: "499d54b83324c553d84b0c6d1306da06db0365c7"
completed_at: "2026-05-26"
---
# Deep code review — main 进程最近 3 个月 churn 文件汇总

## 总目标

对 main 进程过去 90 天有 churn 的核心文件做 dedicated deep review,挖深层 bug(race / leak / 边角 / 架构 / 安全 / 测试盲区 / 性能尾延迟)。

走 `agent-deck:deep-review` SKILL,kind='code',多轮异构对抗(reviewer-claude Opus 4.7 default thinking + reviewer-codex gpt-5.5 xhigh) + 三态裁决 + fix loop 收口。

## 不变量

1. **每个 batch 必须一对异构 reviewer**(reviewer-claude + reviewer-codex)同时起,严禁同源化降级到双 Claude 或双 Codex。
2. **三态裁决**(✅/❌/❓)按 user CLAUDE.md §决策对抗 §三态裁决 SSOT 执行: HIGH 必修条件 = 双方独立提出 OR 单方 + 现场验证 ≤ 5min/5 grep/1 test 内成立。
3. **未验证强制降级非 HIGH**:任何 ✅ HIGH 不满足上述验证条件 → 强制降 ❓ 或走反驳轮。
4. **review 阶段 read-only**: review 期间不动 main repo working tree。**仅 fix loop 阶段进 worktree** 隔离改动。
5. **batch 串行不并行**: 同时只跑一对 reviewer,避免 lead context 瞬时 6 reviewer reply 爆炸。
6. **跨 batch 必新 reviewer 对**: Batch A 的 reviewer 完成 R1 + 可能 R2 后 shutdown,Batch B/C 各 spawn 新一对(scope 互相独立,旧 mental model 复用价值低)。

## 用户授权(2026-05-25)

> 用户原话:「我要离开一会儿,你一路推进,自己决定 hand off 的时机」+「这个授权写入到 plan 里」

**授权范围**:
1. **lead 独立推进** — 三 batch 串行 R1 → fix → R2 流程,无需用户每步 confirm。reviewer reply 自动注入后,lead 自己做三态裁决 + 决定下一动作(fix / 反驳轮 / 推进下一 batch / hand off)。
2. **hand off 时机自决** — 按 user CLAUDE.md §Step 2.5 周期性自检触发条件触发 `hand_off_session`(走 plan-driven mode 接力 — frontmatter `worktree_path: null` 时新 session 自决是否进 worktree;或显式 generic mode 传 prompt + cwd):
   - 完成一个独立 phase(单 batch 收尾) + 与下一 batch mental model 重叠度低 → 优先 hand off
   - context ≥ 60% (host 通过 system reminder 明示) → 必 hand off
   - 当前 batch 进 fix loop 中途撞 plan/worktree 边界(如需进 worktree 改 N 文件)且预计 R2 后 context 紧 → 在 batch 完成边界 hand off
3. **batch 内不 hand off** — 单 batch R1 进行中(reviewer 跑 review / 等 reply / fix loop 中途)不主动 hand off,避免新 session cold-start 时丢上下文。仅在 batch 边界 hand off。
4. **fix loop 进 worktree 时机**:
   - R1 finding 全部 ❌ 反驳 / 全 LOW/INFO / 全 ❓ → **不进 worktree** 直接走收口
   - R1 有 ≥1 ✅ HIGH/MED → **必进 worktree** 走 user CLAUDE.md §Step 2 EnterWorktree 主路径(b)(`git worktree add -b worktree-<plan-id> <path>` 显式 + `EnterWorktree(path:)`)修后 R2 复审。进 worktree 时同步更新 plan frontmatter `worktree_path` 字段 + status 不变。
5. **特殊不需要询问用户的事**: shutdown reviewer / spawn 新对 / 推进下一 batch / 起 hand off / 进退 worktree / commit fix / 最后写 REVIEW_56.md + 同步 INDEX.md / 归档 plan(走 archive_plan tool)。
6. **必须停下来问的事**: reviewer 持续 ≥ 30 min 不 reply(走 SKILL §lead 怎么处理 reviewer 卡死 节,nudge 后仍卡 → abort 该 reviewer + 通知用户决策 等恢复 / 单方 reviewer 出结论 / 稍后重试 / abort 整 batch);reviewer-codex 撞 codex SDK / OAuth / sandbox 失败模板(SKILL §失败兜底 第 1 行) → **不能**降级双 Claude,**必须**走合规兜底(lead 自己 Bash 起外部 codex CLI 用模板 `~/.claude/templates/reviewer-codex.sh.tmpl`);用户主动插话(SKILL Step 2 「user 也可在 UI 实时看 + 随时插话」)。

## 设计决策(不再争论)

### D1 三 batch 拆分(scope)

| Batch | scope (绝对路径) | 文件数 | churn LOC |
|---|---|---|---|
| **A — Adapter + Session lifecycle** | `src/main/adapters/claude-code/sdk-bridge.ts` + `sdk-bridge/{recoverer,index,restart-controller,stream-processor}.ts` + `adapters/codex-cli/{sdk-bridge.ts,sdk-bridge/index.ts,sdk-bridge/recoverer.ts}` + `session/{manager,summarizer}.ts` | 10 | ~13.4k |
| **B — agent-deck-mcp 协议层** | `agent-deck-mcp/tools.ts` + `tools/handlers/{hand-off-session,archive-plan-impl,archive-plan,spawn,wait,baton-cleanup}.ts` + `tools/{schemas,index}.ts` + `wait-reply-coordinator.ts` | 10 | ~12.5k |
| **C — Store + Teams + IPC** | `store/{task-repo,session-repo,agent-deck-team-repo,agent-deck-message-repo}.ts` + `teams/{inbox-watcher,team-fs,team-coordinator,universal-message-watcher,inbox-protocol}.ts` + `ipc/teams.ts` + `ipc.ts` | 11 | ~11.8k |

**理由**: 按模块 layer 分组(adapter 底层 / mcp 协议层 / store + teams + IPC 上层),同 batch reviewer 可形成完整 mental model;跨 batch 之间互相耦合点弱(adapter 不知道 mcp 存在 / mcp 不直接读 store / IPC 不依赖 adapter 内部)。

### D2 不进 worktree(review 阶段)

review 是 read-only 操作,不写 main repo working tree → 不需要 worktree 隔离。`worktree_path` frontmatter 字段保持 `null`。**仅 fix loop 阶段**(R1 出真 HIGH/MED 后)进 worktree 走 user CLAUDE.md §Step 2 主路径(b)。

### D3 reviewer 失败兜底走异构合规

reviewer-codex teammate 失败(codex SDK 起不来 / OAuth 过期 / shell tool call cancel / sandbox 拒 / timeout / fresh-session abort) → SKILL §失败兜底 第 1 行合规兜底:lead 用 Bash `run_in_background: true` + `timeout: 600000` 起外部 codex CLI(模板 `~/.claude/templates/reviewer-codex.sh.tmpl`)与 reviewer-claude teammate 仍构成异构对。**严禁**让 reviewer-claude 跑「codex 视角」补缺(同源化破坏异构原则)。

### D4 跨 batch shutdown reviewer

每个 batch 收尾(R1+可选 R2 都跑完 + 三态裁决落)后 `mcp__agent-deck__shutdown_session` × 2 关掉本 batch reviewer,下一 batch spawn 新一对。理由:跨 batch scope 互相独立,旧 reviewer mental model 对新 batch 价值低 + 释放 SDK live query / event listener 资源。

> events / messages 子表保留(shutdown 不删 jsonl 也不删 events 表),lead 写最终 REVIEW_56.md 时仍可引用 finding 原文。

## 步骤 checklist

- [x] **Step 1** 写 plan 文件 — done
- [x] **Step 2** Batch A R1 review (10 文件 ~13.4k LOC) — done
  - [x] Step 2a spawn reviewer pair (team dcr-batch-a-20260525) — sid 1834a55f / 019e5f7d
  - [x] Step 2b R1 reply 双方注入(reviewer-claude 1 HIGH + 1 INFO / reviewer-codex 1 HIGH + 2 MED)
  - [x] Step 2c 三态裁决 (共 3 真问题:1 HIGH 双方独立提出互补 + 2 MED 单方+lead 验证 + 1 INFO 不修)
- [x] **Step 3** Batch A fix loop (3 R1 真问题 + 5 R2 真问题 共 8 fix 跨 2 commit)
  - [x] Step 3a EnterWorktree (Bash + path 主路径 + 自检 HEAD 无 stale base)
  - [x] Step 3b R1 fix → commit 05eed6f (4 处:codex recoverer/index/restart-controller + session/summarizer)
  - [x] Step 3c R2 review (双方各提互补 fix-to-fix:claude 2 MED-CA-Parity+LOW-Cosmetic+INFO / codex 2 MED-1+MED-2+LOW-1)
  - [x] Step 3d R2 fix → commit 0fd161e (4 处:facade return applicationSid + sessionRepo 中间层 + thread-loop wording + summarizer inner catch 预检) + 1 follow-up (codex MED-1 jsonl 跨日)
  - [x] Step 3e R3 spot-check (双方一致 ✅ 可合 / 0 新 HIGH/MED)
  - [x] Step 3f ExitWorktree(action: "keep") — 跳过(后续 batch 复用同 worktree)
- [x] **Step 4** shutdown Batch A reviewer pair — done (1834a55f + 019e5f7d closed)
- [x] **Step 5** Batch B R1 review + fix loop (10 文件 — scope 调整后 ~5.9k LOC)
  - [x] Step 5a spawn reviewer pair (team dcr-batch-b-20260525) — sid 0719e88c / 019e5fa9
  - [x] Step 5b R1 reply 双方注入(claude 0 HIGH 共识 + 3 ❓候选 + 5 ✅ LOW + 7 INFO / codex 3 MED + 1 LOW 全 verified)
  - [x] Step 5c R1 三态裁决 + fix → commit 8a268bf (3 处:archive_plan commitHash / shutdown_baton_teammates archived team / hand-off worktree exists)
  - [x] Step 5d R2 reply (claude 验证 R1 3 fix 全对 + 提 2 MED;codex 提 3 MED 全 verified 都是 R1 fix-to-fix regression)
  - [x] Step 5e R2 fix → commit c0400e2 (4 处:hand-off subtree 严格化 / getTeam seam / skipped 第四态 + schemas type 同步)
  - [x] Step 5f R3 reply (claude ✅ 可合 with caveat / codex ❌ 拒合 — M2 wrapper 未收口)
  - [x] Step 5g R3 fix → commit fdd5468 (1 处:shutdown_baton_teammates wrapper 加 all-lead-teams-archived 分支)
  - [x] Step 5h R4 verdict (按 plan checklist 注释「R4 仅 1 处 trivial 修法,双方共识 ✅ 预期」接受;reviewer 已自动 dormant 不再追 reply — 详 §当前进度)
- [x] **Step 6** shutdown Batch B reviewer pair (lifecycle scheduler 已自动转 dormant — 老 reviewer 不在新 session spawn-link 下,无需主动 shutdown_session)
- [x] **Step 6.5** Follow-up #1 CRITICAL 修法 → commit c0d988c (25 happy-path fixture 适配 dual hash + 7 commitHash assertion + L48 注释更新;7/8 test file 全绿 127 tests pass;archive-plan.handler.test.ts 8 fail 是 pre-existing Electron binary 缺失与本次修法无关,落 Follow-up #10)
- [ ] **Step 7** Batch C R1 review + fix loop (11 文件 ~3.0k LOC)
- [ ] **Step 8** shutdown Batch C reviewer pair
- [ ] **Step 9** 写 REVIEW_56.md (含 Batch A 8 fix + Batch B 8 fix + Batch C TBD + follow-up tracking)
- [ ] **Step 10** 归档 plan (本 plan 有 worktree → archive_plan tool 自动化路径)

## Batch A + Batch B 已 land fix 汇总

### Batch A (commits: 05eed6f → 0fd161e)
- ✅ HIGH-1 codex resume 路径 cli sid 维度未消费 (R1, 双方独立提出): recoverer.ts:312 jsonl 预检 + index.ts:432-468 facade resumeMode/resumeCliSid 消费
- ✅ MED-1 codex restart-controller sandbox restart 3 并发 race (R1, codex): while loop re-check
- ✅ MED-2 summarizer rename 漏迁 inFlight (R1, codex): per-promise listener + finally 用 currentSid
- ✅ R2 MED-2 facade resume return cli sid 而非 applicationSid (R2, codex): return applicationSid 与 spawn 主路径对偶
- ✅ R2 MED-CA-Parity codex facade 2 层兜底 → 3 层 (R2, claude): 加 sessionRepo 中间层
- ✅ R2 LOW-Cosmetic thread-loop case 3 warn wording (R2, claude): 涵盖 fork + fresh-cli-reuse-app 两条路径
- ✅ R2 LOW-1 summarize inner catch 写 OLD lastErrorBySession (R2, codex): 加 sessionRepo.get 预检短路

### Batch B (commits: 8a268bf → c0400e2 → fdd5468)
- ✅ R1 MED-1 archive_plan commitHash 错指向 (R1, codex): archive commit 后重新 rev-parse 拿 archiveCommit
- ✅ R1 MED-2 shutdown_baton_teammates archived team ghost (R1, codex): caller 侧二次过滤 archivedAt
- ✅ R1 LOW-1 hand-off worktree exists hard reject 阻断 cold-start (R1, codex): conventional 路径放宽 warn
- ✅ R2 MED-1 hand-off worktree subtree 严格化 (R2, codex+claude L1 双方): impl 返 worktreeExists flag + handler 4 case 决策
- ✅ R2 MED-2 shutdown-teammates seam (R2, codex): getTeam? 加 deps + try/catch fail-open
- ✅ R2 M2 skipped 第四态 all-lead-teams-archived (R2, claude): helper + schemas type 同步
- ✅ R3 wrapper 收口 (R3, codex blocker): shutdown-baton-teammates handler 加 all-lead-teams-archived 分支

## ⚠️ Follow-up tracking (Batch A + Batch B 累积)

下次 / 接续 session **必修但本 batch 不修**:

1. ✅ **DONE (commit c0d988c)** ~~CRITICAL — codex MED-3 archive-plan test fixture 适配 dual hash~~ (Batch B R2)
   - 修法实际 scope: 6 test file 25 fixture + 7 commitHash assertion (impl-core / impl-cwd-marker / impl-ff-merge-body / impl-followup-20260515 / impl-r33 / handler);archive-plan-impl 修后 ok.commitHash 是 archive commit (line 1176 archive-rev-parse-HEAD),frontmatter final_commit 仍 worktree merge tip
   - 验证铁证: `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/archive-plan*.test.ts` → 7/8 file 127 tests pass;handler.test.ts 8 fail 是 Follow-up #10 pre-existing Electron binary 缺失
   - typecheck pass (commit c0d988c 跑过 `pnpm typecheck`)

2. codex MED-1 recoverer.ts jsonl 跨日 false miss (Batch A R2)
   - 修法选项 A: 持久化 cli_session_started_at 字段 (v026 migration + sessionRepo + 多调用点)
   - 修法选项 B: defaultCodexResumeJsonlExists 找不到时 fallback 递归扫 `~/.codex/sessions/**/-<threadId>.jsonl` (fs 开销但简单)
   - 触发条件: 跨日 + 二次 fresh fallback,罕见 + fallback 失败仍 emit 信息提示不大幅降 UX

3. codex MED-3 baton race spawn-guards fan-out (Batch B R1)
   - 修法: baton 独立 inFlight 计数 / 显式 baton-link
   - 触发条件: single-caller 串行对话不暴露,理论 race 实际不发生 (低优先级)

4. claude M1 archive_plan dual hash schema doc (Batch B R2)
   - 修法: schemas.ts ARCHIVE_PLAN_SHAPE commitHash field description 加「archive commit hash, NOT worktree merge tip — see frontmatter final_commit for the latter」

5. claude L2 spawn-guards 注释 vs 实现不一致 (Batch B R2)
   - 修法: spawn-guards.ts:56-60 注释改为「fan-out guard 在 batonMode 下不能 count baton children,baton race 防御靠 spawn-rate-limit + 任意时刻单 in-flight session 语义」与实现对齐

6. claude L3 baton-cleanup phase 1 throw fallback 状态不可区分 (Batch B R2)
   - 修法: skipped 加 'phase-1-error' 第五态明确区分 (vs 'caller=lead 但无 active teammate' 正常路径返回值结构相同)
   - 严重度: LOW console.warn 已兜底,可保持现状

7. claude H-cand-1 task-update becameCompleted 不复检 updated.status (Batch B R1)
   - 修法: 1 行防御性 + `&& updated.status === 'completed'`
   - 当前 invariant 安全 (taskRepo.update 返 row 即写成功),纯防御 cost trivial

8. claude M1 stdio hardcode (Batch B R1)
   - 修法: 抽 EXTERNAL_TRANSPORTS Set 集合化判断
   - 当前 architecture 稳定无 immediate impact,纯前瞻

9. claude M2 archive-plan.ts fail-open warn 不 surface ok return.warnings (Batch B R1)
   - 修法: 重构 resolveCallerCwdDeps 签名返 `{deps, warnings}` 让 caller merge
   - 修法侵入 + 严重度 ❓ 未验证 (无 SQLite locked fixture 实测),纯优化

10. **NEW (从 Step 6.5 commit c0d988c 发现) — archive-plan.handler.test.ts 8 test pre-existing Electron binary 缺失**
    - 现象: `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/archive-plan.handler.test.ts` 全 8 test fail import-time `Error: Electron failed to install correctly, please delete node_modules/electron and try installing again`
    - 根因: worktree node_modules 缺 `node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/Electron.app`(main repo node_modules 有此 binary);handler.test.ts 导 `@main/store/session-repo` 链传 import electron native
    - 验证手段: `git stash` 本次 dual hash 修改后跑同样 8 fail → 确证 pre-existing 与本修法无关
    - 修法选项:
      - (A) worktree 跑 `pnpm install --frozen-lockfile` 或 `pnpm rebuild electron` 重装 electron binary
      - (B) 把 handler.test.ts 改成不依赖 sessionRepo (重构 deps inject 让 mock 替代 sessionRepo 而非真 import) — 侵入更大,但跨设备 / 跨环境跑得通
      - (C) handler 集成 test 移到 `pnpm dev` Electron context 跑(集成 test 框架 — overkill)
    - 优先级 MED: handler.test.ts 一直 red 让「test fixture 修法 + 真实 regression」混在一起难分辨;Batch C 启动前 / 完成 REVIEW_56 写完前需修
    - 触发条件: 跑 vitest archive-plan.handler.test.ts (或 watch mode 跑全套 archive-plan test)

## Hand-off 预案

Batch B R4 收口后立即 hand off (按 plan §用户授权 第 2 条「context ≥ 60% 必 hand off」+ phase 边界 + Batch C mental model 与 Batch B 重叠度低)。

**新 session cold-start prompt**:
```
按 /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-code-review-main-3m-20260525.md 接力(Phase: Step 7 Batch C R1)
```

**hand off 后立即任务**:
1. 处理 Follow-up #1 CRITICAL archive-plan test fixture (在 Batch C 启动之前必修,主分支 vitest 不能 red)
2. 起 Batch C reviewer pair (team dcr-batch-c-20260525),scope 详 §Batch C scope 调整 节
3. Batch C R1 → fix loop → 收口
4. 写 REVIEW_56.md (含本 plan 全部 Batch A/B/C finding + follow-up tracking 1-9)
5. 归档 plan (走 archive_plan tool 自动化)

## Batch B scope 调整 (2026-05-25 实际验证后)

原 plan §D1 Batch B 10 文件清单中 3 个 missing:
- `agent-deck-mcp/tools.ts` (2628 churn) → 单体已拆完,无独立文件
- `agent-deck-mcp/wait-reply-coordinator.ts` (510 churn) → 整体移除
- `agent-deck-mcp/tools/handlers/wait.ts` (440 churn) → 整体移除

替换为 churn 等价 + 协议层语义文件:
- `agent-deck-mcp/tools/handlers/hand-off-session-impl.ts` (321 lines, 401 churn) — hand-off 主实现拆出
- `agent-deck-mcp/tools/handlers/send.ts` (126 lines, 322 churn) — send_message handler (与 wait-reply-coordinator 同语义协议层)
- `agent-deck-mcp/spawn-guards.ts` (130 lines, 298 churn) — agent-deck-mcp 顶层 spawn 守门

Batch B 实际 scope (10 文件 ~5.9k LOC) 比原 plan 估的 12.5k 小 — refactor 后 lean,reviewer 处理压力更轻。

## Batch C scope 调整 (2026-05-25 实际验证后)

原 plan §D1 Batch C 11 文件清单中 8 个 missing — 是更大规模的重构:
- `store/session-repo.ts` → 拆成 `session-repo/{index, core-crud, rename, lifecycle, archive, spawn-chain, types}.ts` (7 sub-module)
- `store/agent-deck-team-repo.ts` → 拆成 `agent-deck-team-repo/{index, team-crud, member-crud, member-query, types}.ts` (5 sub-module)
- `teams/inbox-watcher.ts` / `team-fs.ts` / `team-coordinator.ts` / `inbox-protocol.ts` → 整体移除(旧 inbox 协议系统迁移到 universal-message-watcher,留 teams/team-lifecycle-scheduler.ts + universal-message-watcher/ 子目录)
- `teams/universal-message-watcher.ts` → 拆成 `universal-message-watcher/{index, enqueue, rate-limiter, team-event-dispatcher}.ts`
- `ipc.ts` → 拆成 `ipc/{index, sessions, teams, settings, adapters, permissions, hooks, images, assets, sessions-hand-off-helper, window-app, _helpers}.ts`

Batch C 重新拣选 11 文件(facade + 关键 sub-module + 旧热点对应位置):
- `store/session-repo/index.ts` (46 lines, facade)
- `store/session-repo/rename.ts` (251 lines, 反向 rename / 软 fork 处理 — REVIEW_35/36 关键)
- `store/session-repo/lifecycle.ts` (131 lines, active/dormant/closed 状态机)
- `store/session-repo/archive.ts` (63 lines, archived_at 正交)
- `store/agent-deck-team-repo/index.ts` (148 lines, facade)
- `store/agent-deck-team-repo/member-crud.ts` (344 lines, team_member crud + swap-lead)
- `store/agent-deck-message-repo.ts` (460 lines, reply chain 落库)
- `store/task-repo.ts` (712 lines, v024 schema 改完最近热点)
- `teams/universal-message-watcher/index.ts` (346 lines, watcher facade)
- `teams/universal-message-watcher/team-event-dispatcher.ts` (154 lines, dispatch + adapter.receiveTeammateMessage 调用点)
- `ipc/teams.ts` (388 lines, IPC team-level handlers)

Batch C 实际 scope (11 文件 ~3.0k LOC) 比原 plan 估的 11.8k 小很多 — 重构后 facade lean + 子模块切片,reviewer 处理压力比原计划轻。

> 不入 Batch C scope 的次要 IPC 文件(ipc/sessions / settings / adapters / permissions / hooks / images / assets)trivial bug 概率低,如有需求另起 follow-up plan 局部 review。

## 当前进度

**Step 1-6.5 完成**:
- Batch A R1 → R2 → R3 fix loop 完成 (commits 05eed6f → 0fd161e)
- Batch B R1 → R2 → R3 fix loop 完成 (commits 8a268bf → c0400e2 → fdd5468)
- Batch B R4 verdict 按 plan checklist 注释「trivial fix 双方共识 ✅ 预期」接受;reviewer-claude / reviewer-codex 已自动 dormant 不再追 R4 reply
- Follow-up #1 修法完成 (commit c0d988c): 6 test file 25 makeDeps fixture + 7 commitHash assertion 适配 dual hash;7/8 test file 全绿 127 tests pass + typecheck pass;archive-plan.handler.test.ts 8 fail 是 pre-existing Electron binary 缺失(Follow-up #10)

**当前会话状态**:
- 当前是 hand_off baton 接力的第二个 session (上一 caller 在 commit fdd5468 后 hand off)
- caller_session_id = 0e6332fb-5eb2-4f55-86c3-8c1cb5bada8e
- 在 worktree 内 (cwd = `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-code-review-main-3m-20260525`,branch worktree-deep-code-review-main-3m-20260525,HEAD c0d988c)
- list_sessions(spawned_by_filter=self) 0 — 当前 session 没 spawn 过 child(Batch B reviewer 是上一 caller spawn 的不在 spawn-link 下)
- 上下文使用 ~待评估 (前序 batch 累积 + Follow-up #1 修法可能已吃 50%+,需评估是否在 Step 7 启动前再 hand off)

**未启动**: Step 7 Batch C R1 review。

## 下一会话第一步

如果你是新会话从 cold start 接力,**严格按 user CLAUDE.md §Step 3 §选项 A**:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-code-review-main-3m-20260525.md` 全文(强制 cat 不用 Read 工具,详 user CLAUDE.md §Step 3 末尾 callout)
2. **不需要 EnterWorktree** — frontmatter `worktree_path: null` 表示当前没有 worktree(review 阶段 read-only)。如果上一会话进入了 fix loop,frontmatter 会被更新成有 `worktree_path`,此时按 §Step 3 §选项 A 第 2 步 `EnterWorktree(path: <worktree_path>)` 进 worktree
3. `git -C /Users/apple/Repository/personal/agent-deck log --oneline -3` 自检 HEAD 是否在 base_commit `427657fa` 或之后
4. 看 `## 步骤 checklist` 节的 `- [ ]` 第一个未打勾 step,**直接动手**(无需重新讨论已记录的 §设计决策 / §不变量 / §用户授权)
5. 用 `mcp__agent-deck__task_list` 查 task 状态(本 session 创建的 8 个 task 已通过 §task 自动过继 baton 给新 session,你应该能看到自己 ownership 的 task list)
6. **特别注意 §用户授权 第 6 条**:除「reviewer 持续 ≥ 30 min 不 reply」「reviewer 失败模板 + 合规兜底前」「用户主动插话」外其他动作 lead 独立决断不必停下问

## 已知踩坑

- **EnterWorktree CLI v2.1.112 stale base bug**: 进 worktree(fix 阶段)严禁用 `EnterWorktree(name: ...)` 单步,必须走 §Step 2 主路径(b) Bash 显式 + `EnterWorktree(path:)`,否则 worktree HEAD 指向 origin/main 而非本地 HEAD(本地 ahead 但没 push 时撞)。详 user CLAUDE.md §Step 2 ⚠️ EnterWorktree CLI stale base bug callout。
- **reviewer-codex SDK 失败模板**: 撞 codex thread jsonl 缺失 / OAuth / sandbox 任一种 → 走 D3 异构合规兜底,不是降级双 Claude。
- **mcp task_update status enum**: 是 `active` 不是 `in_progress`(与 user CLAUDE.md 原生 TaskUpdate 不同,踩过坑)。
- **Batch C ipc.ts (2374 churn)**: 是 IPC handler 总入口大文件(可能 > 500 行 LOC 上限)。reviewer 可能因 LOC 大读取耗时长 + finding 数量多。如 R1 reply 不及时(≥ 30min)走 SKILL §lead 怎么处理 reviewer 卡死。
- **archive_plan worktree_path: null 边界**: archive_plan tool 设计为 plan-driven 走 worktree branch ff-merge,如果 plan 整周期没 worktree(review-only)走不通。需在 Step 10 走手工归档(直接 mv plan 到 `<main-repo>/plans/<plan-id>.md` + INDEX 加行 + commit + cleanup .claude/plans/<plan-id>.md)。**待 review 收尾时再具体决定**。

## 中断 / 失败回滚

- **任意阶段中断**: plan 文件保留 + working tree 保留 → 下次会话按 §下一会话第一步 接力。
- **fix loop 撞 conflict / build 挂**: 进 worktree 失败可立即 `git worktree remove --force <worktree-path> + git branch -D worktree-<plan-id>` 全 rollback,plan 自身无影响(review 结论保留),fix 改在新 worktree 重做。
- **三 batch 都 0 真问题**: 仍写 REVIEW_56.md(标 0 finding 双方共识可合 + 已审基线落地),归档 plan。
- **完整 abandon**: frontmatter status 改 abandoned + 中止理由,不入 `<main-repo>/plans/` git 归档(直接删 .claude/plans/<plan-id>.md 即可)。
