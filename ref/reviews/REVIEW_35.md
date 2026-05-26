---
review_id: REVIEW_35
title: deep-review-and-refactor-20260514 12 文件热点综合 R1 + Wave 2 + R2 三轮异构对抗
created_at: 2026-05-14
plan_id: deep-review-and-refactor-20260514
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514
base_commit: d06494e98c8e5a6d7eef2b0fc66ea6e69bf07d5a
final_commit: 4a85f68
heterogeneous_dual_completed: true
---

# REVIEW_35 — deep-review-and-refactor-20260514 12 文件热点综合 review × fix 三轮收口

## 触发场景

用户主动「deep code review 下本项目代码有没有可以优化的空间和需要重构的地方」。`agent-deck:deep-code-review` SKILL 多轮异构对抗模式。

## 方法

### Scope = 热点综合（12 文件，跨 4 batch）

经 wc -l + git churn (30d) + reviews/ INDEX 历史覆盖交叉过滤选 12 个热点文件，跨 4 个子系统：

- **Batch A** — Universal team backend 数据层 + 路由层（agent-deck-message-repo / agent-deck-team-repo/ / universal-message-watcher）
- **Batch B** — Session 子系统（summarizer / preload/index / session-store）
- **Batch C** — Adapter / PTY / 安全护栏（pty-bridge/ / can-use-tool / ansi-parser，inbox-watcher 已删除自动跳过）
- **Batch D** — Renderer + 资源管理 + 未审热点（useImageAttachments **从未被任何 review 覆盖** / ComposerSdk / main/index）

### 异构对抗 reviewer（每 batch 一对，共 8 reviewer）

| Batch | reviewer-claude | reviewer-codex |
|---|---|---|
| A team-backend | rA-claude (Opus 4.7) | rB-codex (gpt-5.5 xhigh) |
| B session-subsystem | rC-claude (Opus 4.7) | rD-codex (gpt-5.5 xhigh) |
| C adapter/pty | rE-claude (Opus 4.7) | rF-codex (gpt-5.5 xhigh) |
| D renderer/未审热点 | rG-claude (Opus 4.7) | rH-codex (gpt-5.5 xhigh) |

### 工作流（用户选项：2 轮 + 全程 fix 收口 + 4 维 focus）

- **R1** 8 reviewer 并发，分两 wave 跑（Wave 1 = Batch A+B / Wave 2 = Batch C+D）
- **R1 三态裁决** + 反驳轮（HIGH 单方独有走反驳轮：3 条；其余 lead grep+read 实证）
- **Wave 1 fix** (commit cd1af8c, 15 真问题) + Wave 2 fix (commit d2c9e68, 12 真问题)
- **R2** 复用同 8 reviewer（in-process backend，跨轮 mental model 经 SDK 自动 resume），8 个 send_message 并发带 skip 字段（R1 fix 摘要）
- **R2 三态裁决**：又挖出 **5 个新 HIGH**（含 3 个 fix-to-fix 衍生 race / fix 不彻底）
- **R2 fix** (commit 4a85f68, 9 真问题)
- 收口：超出用户选 2 轮，但 R2 5 HIGH 全修 + typecheck/test 全过 = 实操收口

## 三态裁决总表

### Wave 1 (R1 Batch A + B)

| # | Finding | Severity | 来源 | 裁决 | Fix |
|---|---|---|---|---|---|
| A-H1 | universal-message-watcher.ts:413 backpressure inflight > maxInflight 死锁 | HIGH | rB-codex 提 + rA-claude 反驳同意 + lead 实证 | ✅ | cd1af8c：`inflight - 1 > maxInflight` + starvation guard 强制 deliver candidates[0] + 2 存在性 regression test |
| A-M1 | dispatcher cache 漏 runtime created team 首次 archive 被吞 | MED | 双方独立提出 ✅ | ✅ | cd1af8c：加 `eventBus.on('agent-deck-team-created')` listener |
| A-M2 | resolveFromDisplayName 全表扫 listAllMembers N+1 | MED | rA-claude 单方 + lead 实证 | ✅ | cd1af8c：加 `findActiveMembershipIn(teamId, sessionId)` PK lookup |
| A-M3 | markDelivered vs cancel race | MED | rA-claude 单方 | ❓ | follow-up（边界 race，cancel API 注释承认） |
| A-M4 | universal-message-watcher.ts 539 LOC 超护栏 | MED | rA-claude MED + rB-codex LOW | ⚠️ | follow-up（高风险拆分留独立 plan） |
| A-M5 | enqueueAgentDeckMessage rate slot 失败 insert 仍扣 | MED | rA-claude 单方 | ❓ | follow-up |
| A-M6 | addMember 不维护 「active team 必须至少 1 lead」 invariant docstring | MED | rB-codex 单方 | ❓ | follow-up（docstring 与实际行为不一致，设计意图分歧） |
| A-M7 | spawn/cli/ipc.adapters 三处不 emit `agent-deck-team-member-changed` | MED | rB-codex 单方 + lead 实证 | ✅ | cd1af8c：三处补 emit |
| A-L1 | listActiveMembers 不 JOIN sessions.archived_at | LOW | rA-claude 单方 | ✅ | cd1af8c：加 INNER JOIN |
| A-L2 | countActiveLeads 在 throw 错误信息里调两次 | LOW | rA-claude 单方 | ✅ | cd1af8c：缓存 |
| A-L3 | listBySession from_session_id 无索引 | LOW | rB-codex 单方 | ❓ | follow-up |
| A-L4 | watcher 测试缺 process() 集成 case + backpressure case | LOW | rB-codex 单方 | ⚠️ | cd1af8c 补 2 个存在性 test（实际 stateful 行为测试是 R2 MED-A1 提的技术债） |
| A-L5 | backoffMs() JS 与 SQL SSOT 漂移 | LOW | rA-claude 单方 | ✅ | cd1af8c：加 SSOT 警告 docstring |
| B-H1 | summarizer.ts:170 codex-cli 路径无 timeout → inFlight 死锁 | HIGH(codex)/MED(claude) | 双方独立 ✅ | ✅ | cd1af8c：caller 加 Promise.race(codexPromise, timer) 包装 |
| B-M1 | LLM 错误诊断在 fallback 成功时被 lastErrorBySession.delete 清掉 | MED | rD-codex 单方 + lead 实证 | ✅ | cd1af8c：summarize 内部维护 set/delete，caller .then 不再 touch |
| B-M2 | session-rename 不迁移 summarizer per-session 状态 | MED(codex)/LOW(claude) | 双方独立 ✅ | ✅ | cd1af8c：summarizer 加 session-renamed listener |
| B-M3 | 第二档 fallback 抛错时不会触发第三档兜底 | MED | rD-codex 单方 | ❓ | follow-up（DB 异常极低） |
| B-M4 | preload electronIpc raw 通道绕过强类型 facade | MED(codex)/INFO(claude) | 双方独立 ✅ | ✅ | cd1af8c：删 preload electronIpc 暴露 + 删 src/renderer/lib/ipc.ts |
| B-M5 | session-store.ts view 字段死代码 + 类型不符 | MED | rC-claude 单方 + lead 实证 | ✅ | cd1af8c：删 store.view + setView |
| B-M6 | summarizer 三档 fallback / session-store 关键不变量 0 单测 | MED | rC-claude 单方 | ⚠️ | follow-up（renderer 测试基础设施 + 写 stateful test）|
| B-L1 | summarizer.ts 546 LOC 超护栏 | LOW | rD-codex 单方 | ⚠️ | follow-up |
| B-L2 | preload/index.ts 526 LOC 超护栏 | LOW | rD-codex 单方 | ⚠️ | follow-up |
| B-L3 | summarizer `if (timedOut) throw` 死代码（两处）| LOW | rC-claude 单方 | ✅ | cd1af8c：删 + 删 let timedOut 变量 |
| B-L4 | listFileChanges/getSettings preload `unknown` 类型 | LOW | rC-claude 单方 | ✅ | cd1af8c：改强类型 FileChangeRecord/AppSettings |
| B-L5 | setLatestSummaries 不比 ts → 启动窗口 stale 覆盖 fresh | LOW | rC-claude 单方 | ✅ | cd1af8c：与 pushSummary 对齐 ts 比较 |
| B-L6 | truncate UTF-16 surrogate pair 切碎 | LOW | rC-claude 单方 | ❓ | follow-up（cosmetic） |
| B-INFO1 | model fallback ANTHROPIC_MODEL 让 summarizer 跑 opus | INFO | rC-claude 单方 | ❓ | 不修（产品决策） |

**Wave 1 R1 小计**：2 HIGH + 14 MED + 11 LOW + 1 INFO = 28 finding，修 15 真问题（2 HIGH + 8 MED + 5 LOW），follow-up 13。

### Wave 2 (R1 Batch C + D)

| # | Finding | Severity | 来源 | 裁决 | Fix |
|---|---|---|---|---|---|
| D-H1 | useImageAttachments add 30MB race（闭包陈旧）| HIGH | 双方独立 ✅ + rG-claude Node sim 实测 47MB | ✅ | d2c9e68：limit check 移 setAttachments updater 内 + admitted 回滚 fullBase64Ref + deps=[]（**Wave 2 fix 不彻底，R2 重修**）|
| D-H2 codex | ComposerSdk attachments adapter gating（generic-pty/aider 静默丢图）| HIGH | rH-codex 提 + rG-claude 反驳同意 + lead 实证 | ✅ | d2c9e68：types.ts canAcceptAttachments + ComposerSdk gate 入口 + send 入口拦截（**R2 codex H1 补 IPC last-line defense**）|
| D-H2 claude | main/index.ts singleton lock 失败缺 return | HIGH→MED | rG-claude 提 + rH-codex 反驳证伪「必现」+ ESM top-level return 语法 bug | ✅ MED | d2c9e68：所有 listener 移到 if(gotLock){...} 分支（**R2 codex H2 补 bootstrap fatal reject 兜底**）|
| C-M3 | IdleDetector dispose 漏 disposed flag | MED | rE-claude 单方 + Node 实测复现 | ✅ | d2c9e68：加 disposed flag |
| C-M4 | READ_ONLY_TOOLS 缺 TaskOutput | MED | rE-claude 单方 + strings 验证 SDK 21 工具 | ✅ | d2c9e68：加 TaskOutput |
| C-M5 | pty sendMessage emit 在 write 之前 → write throw 时 UI 假已发 | MED | rE-claude 单方 | ❓ | follow-up（race window 极小） |
| C-M1 codex | pty-bridge listener 后注册 → 秒退命令丢 exit | MED | rF-codex 单方 + node-pty 实测 misses=6/20 | ❓ | follow-up（重排 spawn 顺序需小心） |
| C-M2 codex | 每 PTY session 一 chokidar，无 root/复用护栏 | MED | rF-codex 单方 | ❓ | follow-up（架构改动） |
| C-L1 | can-use-tool tool_use_id vs SDK toolUseID typo | LOW | rF-codex 单方 | ✅ | d2c9e68：优先读 toolUseID 兼容老 tool_use_id（**R2 MED 测试 typo 补 makeCtx 修法**）|
| C-L2 | LS 工具在 SDK 0.2.118 不存在 dead constant | LOW | rE-claude 单方 + strings 验证 | ✅ | d2c9e68：删 LS |
| C-L3 ~ L9 | file-watcher cwd / chokidar throw / ExitPlanMode 测试 / shutdownAll race / fileWatcher.close swallow / spawn-helper chmod silent | LOW | rE-claude 单方 | ❓ | follow-up |
| D-M-claude-3 | makeThumbnail 无白底 → png 透明区缩略图变黑底 | MED | rG-claude 单方 + lead 实证 | ✅ | d2c9e68：globalCompositeOperation 'destination-over' + fillRect |
| D-M-claude-4 | busy state async 双 send race | MED | rG-claude 单方 + lead 实证 | ✅ | d2c9e68：加 busyRef 同步锁 |
| D-M-claude-5 | bootstrap 230 行无抽象 | MED | rG-claude 单方 | ⚠️ | follow-up（重构性留独立 plan） |
| D-M-claude-6 | before-quit cleanup 无 timeout | MED | rG-claude 单方 + lead 实证 | ✅ | d2c9e68：cleanup race-with-timeout 10s + process.exit(1)（**R2 MED-D R2-3 补 closeDb 移 race 外**）|
| D-M-codex-2 | GIF 缩略图完整 dataUrl 进 React state | MED | rH-codex 单方 | ❓ | follow-up（影响有限） |
| D-M-codex-3 | permission 错判 generic-pty/aider 显示下拉切换抛错 | MED | rH-codex 单方 + lead 实证 | ✅ | d2c9e68：supportsPermissionMode 改 `=== 'claude-code'` |
| D-M-codex-4 | second-instance argv pre-bootstrap race | MED | rH-codex 单方 + lead 实证 | ✅ | d2c9e68：second-instance handler 等 bootstrappedPromise |
| D-L-codex-1 | 成功 add 不清旧 error | LOW | rH-codex 单方 | ✅ | d2c9e68：仅 errors.length === 0 时 setError(null) |
| D-L-codex-2 | useImageAttachments 401 LOC 0 测试 + renderer 无 vitest 环境 | LOW | rH-codex 单方 | ⚠️ | follow-up |
| D-L-claude-7/8 + D-INFO 4 | Promise.all 双倍读 / COMPRESS 卡 UI / sandbox 抽象 / id collision / env timing / mcpHttpEnabled limitation | LOW/INFO | rG-claude 单方 | ❓ | follow-up |

**Wave 2 R1 小计**：3 HIGH + 12 MED + 2 LOW + 4 INFO = 21 finding，修 12 真问题（2 HIGH + 1 HIGH→MED + 7 MED + 2 LOW），follow-up 9。

### R2 复审（8 reviewer 并发，复用 same pair）

| # | Finding | Severity | 来源 | 裁决 | Fix |
|---|---|---|---|---|---|
| HIGH-A1 R2 | dispatcher cache fix 半解（spawn_session/CLI/ipc.adapters 仍漏 emit）| HIGH | rA-claude + rB-codex 双方一致 | ✅ | 4a85f68：dispatcher team-updated handler 「未见 team」分支细分（cur=null 才 baseline，cur!=null 当 archive transition）|
| HIGH-B1 R2 | in-flight summary 在 rename 后仍按旧 sid 写库 → SQLite FK 失败 | HIGH | rD-codex 单方 + rC-claude 同根因 MED | ✅ | 4a85f68：.then() insert 前 + .catch() set 前都 sessionRepo.get 预检短路 |
| HIGH-D R2-1 | admitted 闭包不可靠 + fullBase64Ref 孤儿 leak | HIGH | rG-claude 单方 + Node sim 实测 + rH-codex 同根因 MED | ✅ | 4a85f68：fullBase64Ref.set 也移到 setAttachments updater 内 |
| HIGH-D R2 codex H1 | IPC layer 没 capability gate | HIGH | rH-codex 单方 | ✅ | 4a85f68：sendMessage / createSession 两个 IPC handler 加 `!adapter.capabilities.canAcceptAttachments` throw IpcInputError |
| HIGH-D R2 codex H2 | bootstrap fatal reject 只 log 不退出 | HIGH | rH-codex 单方 | ✅ | 4a85f68：catch 内 dialog.showErrorBox + app.exit(1) |
| MED-A1 R2 | backpressure regression test 是 regex grep 不是 stateful | MED | rA-claude 单方 | ⚠️ | follow-up（rA 自承认技术债，需 in-memory db + spy mock） |
| MED-A2 R2 | findActiveMembershipIn 无单测 + listActiveMembers JOIN 无回归 | MED | rA-claude 单方 | ⚠️ | follow-up |
| MED-A3 R2 | starvation guard 不公平（cold target 等热 target backlog 排干 100/10000 → 86/9986 ticks）| MED | rA-claude + rB-codex 双方一致 | ⚠️ | follow-up（架构改动 - per-target 公平排队需重设计） |
| MED-A4 R2 | dispatcher.start() idempotency 只检查 offMember | MED | rA-claude 单方 | ❓ | follow-up（防御性，非真问题） |
| MED rE R2 #1 | toolUseID test typo (makeCtx 还在传 tool_use_id) | MED | rE-claude + rF-codex 双方一致 | ✅ | 4a85f68：makeCtx 双字段 + tu-ask-1 改用 toolUseID |
| MED rE R2 #2/#3 | IdleDetector dispose flag / TaskOutput READ_ONLY 无回归测试 | MED | rE-claude 单方 | ⚠️ | follow-up |
| MED rE R2 #4 | createSession pty.write throw state leak | MED | rE-claude 单方 | ❓ | follow-up（PTY 半挂状态难造） |
| MED rF R2 #1 | ctx.signal aborted 同步预检缺 | MED | rF-codex 单方 | ✅ | 4a85f68：3 处 abort listener 都加同步预检 |
| MED rF R2 #2 | lifecycle.ts:46 SIGTERM kill() throw 时 sessions Map 不清 | MED | rF-codex 单方 | ❓ | follow-up |
| MED-D R2-2 (rG/rH) | canAcceptAttachments 硬编码 vs capability flag SSOT 漂移 | MED/LOW | 双方一致 | ❓ | follow-up（短期 4 adapter 等价；新加 adapter 时再补 capability 接入 hook）|
| MED-D R2-3 (rG) | closeDb 在 race 内 → SQLite WAL checkpoint 风险 | MED | rG-claude 单方 | ✅ | 4a85f68：closeDb 移 race **外** 总是跑 |
| MED-D R2-4/5/6 (rG) | 双倍读 base64 / COMPRESS 卡 UI / bootstrap 巨函数 | MED | rG-claude 单方 | ⚠️ | follow-up |
| MED-D R2-7 (rG) | commit d2c9e68 fix 无伴随回归测试 | MED | rG-claude 单方 | ⚠️ | follow-up（与 R2-A1 同 pattern，整批 fix 都缺 stateful test） |
| MED-D R2-8 (rG) | bootstrap reject 路径下 second-instance argv 静默吞 | MED | rG-claude 单方 | 与 R2 codex H2 同 fix 部分覆盖（catch 内 app.exit 让二次启动重新走完整流程，不再 then 吞） |
| MED rD codex (B) | codex thread 持续 hang 时 N 个 orphan thread 累积 | MED/INFO | rD-codex 单方 | ❓ | follow-up（codex SDK 没 abort API 是已知 limitation） |
| LOW rB codex / rC claude / rE / rF / rG / rH multiple | 多条优化 / 测试盲区 / cosmetic | LOW/INFO | 单方 | ❓ | follow-up |

**R2 小计**：5 HIGH + 多 MED + 多 LOW = 又挖 30+ finding，修 5 HIGH + 4 MED = 9 真问题（含 2 个 R1/Wave 2 fix 引入的衍生 race + 1 个 fix 不彻底）。

## 总修复统计

| Severity | Wave 1 | Wave 2 | R2 | 合计 |
|---|---|---|---|---|
| HIGH | 2 | 2 (+1 降 MED) | 5 | **9** |
| MED | 8 | 7 (+1 升自 HIGH) | 4 | **20** |
| LOW | 5 | 2 | 0 | **7** |
| 总计 | 15 | 12 | 9 | **36** |

| follow-up | Wave 1 | Wave 2 | R2 | 合计 |
|---|---|---|---|---|
| MED follow-up | 5 | 4 | 9 | 18 |
| LOW/INFO follow-up | 8 | 11 | 多 | 25+ |

## 关联 commit

- `cd1af8c` Wave 1 fix (15 真问题)
- `d2c9e68` Wave 2 fix (12 真问题)
- `4a85f68` R2 fix (9 真问题)

## 关键收获 / agent-pitfall

1. **fix-to-fix 衍生 race**：Wave 1/2 修了的问题，R2 又挖出 fix 本身引入的新 race（HIGH-B1 R2 session-renamed listener 只迁 Map state 不覆盖 in-flight promise；HIGH-D R2-1 React 18 batching 让闭包 admitted 不可靠 → ref 孤儿 leak）。**修法在 fix 提交前用 R2 reviewer 复审是必要的**。
2. **dispatcher cache fix 半解**：HIGH-A1 R2 揭示 emit 路径不齐时单点 fix 不够 — 需要 SSOT 在 caller 层（多处 emit）或 receiver 层（dispatcher 防御）二选一。本次走防御方案（dispatcher 兼容「未见 team 但已 archived」），代价小但语义显式。
3. **regression test 必须 stateful 而非 regex grep**：Wave 1 backpressure fix 我用了「源码 regex 字面量校验」当 regression test，rA-claude R2 直接指出是技术债 — 未来重构时无 safety net。**fix 必须配套 stateful 行为测试**（in-memory db + spy mock），下次必须遵守。
4. **scope path 必须 git ls-files 实证不能用 stale wc -l**：Wave 2 spawn 时把 inbox-watcher.ts (已删除 commit 7d36b07) 和 pty-bridge.ts (已拆成目录 commit b7e4dce) 写进 scope，reviewer 自动 pivot 但浪费 token。**spawn 前必须 `git ls-files | grep <file>` 实证**。
5. **scope 路径全用绝对路径含 worktree 前缀**：reviewer 看到的 prompt 路径如果不是 worktree 内绝对路径会触发 SCOPE PATH MISMATCH。本次 12 文件全部用 `/Users/.../.claude/worktrees/<plan-id>/...` 形态，0 报警。

## Follow-up plan 候选

按 R1+R2 finding 严重度优先级排序，建议下一轮 review 涵盖：

**优先级 1（真问题，影响生产但本轮没修）**：
- A3 R2 starvation guard 不公平（per-target 公平排队架构改动）
- C-M5 pty sendMessage emit/write 非原子
- C-M1 pty-bridge listener 注册时序
- rF R2-2 lifecycle.ts SIGTERM kill() throw 兜底
- rH R2-M3 useImageAttachments unmount race + R2-M4 HookServer EADDRINUSE

**优先级 2（测试盲区）**：
- A1/A2 R2 backpressure stateful test + findActiveMembershipIn 单测
- rE R2 #2/#3 IdleDetector / TaskOutput regression test
- rG R2-7 fix 无伴随测试系统性问题
- rC LOW summarizer 关键 fix 直接测试守门

**优先级 3（重构 / 拆分护栏）**：
- A-M4 universal-message-watcher.ts 539 LOC 拆 4 文件
- B-L1 summarizer.ts 613 LOC 拆 hand-off helper
- B-L2 preload/index.ts 524 LOC 按 domain 拆
- D-M-claude-5 main bootstrap 230 行抽象 setupX 系列

**优先级 4（性能 / cosmetic）**：
- D-M-codex-2 GIF dataUrl 入 state
- D-L-claude-7 双倍读 base64
- D-L-claude-8 COMPRESS 7 档卡 UI
- 多条 LOW 顺手清

## 测试与构建

- typecheck: 0 errors
- vitest: 467 passed + 59 skipped (better-sqlite3 binding ABI mismatch SOP 跳过) / 0 failed

## skipped_expired

无（本轮所有命中 file-level review expiry 的过期文件全审）。
