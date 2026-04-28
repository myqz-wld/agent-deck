---
review_id: 8
reviewed_at: 2026-04-28
expired: false
---

# REVIEW_8: ExitPlanMode 4 档目标权限 + bypass 冷切方案对抗审视

## 触发场景

用户报「会话开 plan mode 后权限好像会停留在 plan mode」。Explore subagent 摸现状发现根因不是控件锁，是 `respondExitPlanMode` 批准时只让 SDK 退出 plan mode，但应用层 DB 与下拉未同步切到目标 mode → recoverAndSend 又按 plan 重启。

用户敲定方案：批准时让用户选 4 档目标 mode，bypass 必须冷切（重启 SDK 子进程）。该方案触动 sdk-bridge / ipc / PendingTab / SessionDetail 多模块（~465 行），属于「出执行计划 + 重要技术选型」，按 CLAUDE.md「决策对抗」节走双异构 Agent 对抗审视方案的 7 处关键设计点。

## 方法

**双对抗配对**（异构 SDK / 模型）：
- **Agent A**：Claude Code 内部 `general-purpose` subagent（Opus 4.7 xhigh）—— 范围 medium，要求每条结论 ✅/❌/⚠️ + 文件:行号 + 代码片段
- **Agent B**：外部 Codex CLI（gpt-5.5 xhigh，prompt 经登录式 zsh + sandbox=read-only + `-o` 抓最终答案）—— 同 7 个问题独立判断

**范围**：方案 7 个关键设计点，约 8 文件 / ~465 行预估改动

```text
[问题 1] 冷切复用 recoverAndSend 是否可行？
[问题 2] sessionId rename 时 in-memory pending Maps 是否丢
[问题 3] respondExitPlanMode allow + 立即重启的时序风险
[问题 4] DB 写入时机翻转（cold vs hot）
[问题 5] 冷切失败回滚补偿
[问题 6] 批量批准混档处理
[问题 7] CLAUDE.md「会话恢复 / 断连 UX」护栏对齐
```

**约束**：每条结论必须带文件:行号 + 关键代码片段；不接受「需要谨慎处理」「视情况而定」式废话；总判断要给最大风险点 + 必改设计。

## 三态裁决结果

### ✅ 真问题（双方独立提出 / 一方提出但现场核实成立）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| 1 | HIGH | sdk-bridge.ts:153-158 | `recoverAndSend(sid, "")` 不可行：`createSession` 入口校验 `prompt.trim()` 非空（SDK streaming 协议必须有首条 user message 才启 CLI），且 `recoverAndSend` 顶部强制 emit「⚠ SDK 通道已断开」占位 msg 文案对冷切不对 | ✅ 抽 `restartSession` | ✅ 抽 `restartWithPermissionMode` + handoff prompt 必须非空 |
| 2 | HIGH | sdk-bridge.ts:300-308 | **最大风险点**：bypass approval allow + 立即重启会触发 jsonl flush race。allow → SDK tool_result 推进 stream → CLI 接到才写 jsonl；同时重启子进程，新 SDK `--resume` 起来看到「ExitPlanMode 还没结果」会重发或卡死。race 跟磁盘 IO 走，无法稳定复现 | ✅ deny + feedback + plan-as-prompt | ✅ deny + interrupt:true + handoff prompt |
| 3 | MED | sdk-bridge.ts:993-1004 | 已存在的 zombie 隐患：`closeSession` 清三个 in-memory pending Maps 时**只**清 timer + Map，**不**emit `*-cancelled` 事件给 renderer。store 残留 zombie row（用户点了 silently no-op）。冷切场景频率高才浮现 | ✅ 顺手修 close 内批量 emit cancel | ⚠️ 单独提出但归到设计点 2（rename 不迁 in-memory map） |
| 4 | MED | sdk-bridge.ts:454+711 | 冷切失败：DB 已被翻为 bypass + sessions Map 留死 query（30s fallback 路径不抛错走 `resolve(fallbackId)`）。如果不主动回滚，UI 下拉显示 bypass 但 SDK 实际死透，且原 ExitPlanMode entry 已 drain 走不回来，用户无路重试 | ⚠️ 回滚 + zombie 检测 | ❌ 必须 try/catch 回滚 + **不要 re-emit 假 row**（resolver 已死 silently no-op） |
| 5 | LOW | manager.ts:411-421 | `renameSdkSession` 只迁 sessionRepo subtables + sdkOwned，**不迁** `ClaudeSdkBridge.sessions` 内的 in-memory pending Maps（这三在 InternalSession，不在 SessionManager） | ⚠️ 不构成 bug（按新流程 close OLD 会清，但需配合点 3 emit cancel） | ❌ 真 bug：renderer 端 rename 会迁 + main 端 NEW 是空 → `respondExitPlanMode(NEW, oldRequestId)` silently no-op。但冷切流程下 entry 已 drain，不影响（双方分歧，现场裁决「不构成 bug」） |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| A | 「DB 时机全档翻为 DB→adapter」 | B 反驳：hot path 保持 adapter→DB 更稳（避免 SDK 拒绝时 DB 脏，虽然 parsePermissionMode 已白名单）。**采纳 B**：cold path 翻 DB→adapter，hot path 不动 |
| A | 「批量按钮只 keep current mode（不给选档）」 | B 反驳：用户可能想批量切到 acceptEdits（高频用例），强制 keep 失了便利。**采纳 B**：section 级 shared selector 仅 3 热档，bypass 必须 row 内单条 |

### ⚠️ 部分（双方都看到现场但角度不同）

| 现场 | A 视角 | B 视角 | 结论 |
|---|---|---|---|
| CLAUDE.md 护栏对齐（设计点 7）| 共用 `recovering` Map + 占位 msg + 子表迁移 | + `recovering` continuation 假设 sendMessage，no-prompt restart 不适合 | A + B 互补：复用 H4/H1 护栏但**抽新方法**（不复用 recoverAndSend 的 send 后续逻辑），`recovering` Map key 共用、in-flight 互等 |

## 修复（CHANGELOG_33 落地）

### HIGH（最大风险，必改）
1. **sdk-bridge.ts:300-308 + respondExitPlanMode** — 给 ExitPlanModeResponse 加 `approve-bypass` 独立 decision，resolver 走 deny + interrupt:true 中止 OLD turn；外层调 `restartWithPermissionMode` 用 plan 文本作 handoff prompt 重启到 bypass
2. **sdk-bridge.ts: 新增 restartWithPermissionMode** — 抽新方法供 ExitPlanMode 批准 bypass / SessionDetail 下拉切 bypass / 未来其他冷切场景共用，handoffPrompt 必须非空，单飞共用 `recovering` Map

### MED
3. **sdk-bridge.ts:993-1004 closeSession** — 顺手修 zombie：清 in-memory Map 之前批量 emit `*-cancelled` 事件给 renderer
4. **sdk-bridge.ts: restartWithPermissionMode 失败回滚** — try/catch 包 createSession + snapshot oldMode 回滚 DB + emit error msg + 不 re-emit 假 row

### LOW
5. **ipc.ts:451-462 SetPermissionMode handler** — bypass 路由到 `restartWithPermissionMode`（cold path），其他档保持 adapter→DB（hot path）
6. **PendingTab.tsx batch + ExitPlanRow** — section 级 shared selector（仅 3 热档）+ ExitPlanRow 4 档下拉 + bypass row 内 confirm
7. **SessionDetail.tsx changeMode** — bypass confirm 文案对齐冷切实现（旧文案误导用户「该模式在已运行的会话上不一定生效」）

## 关联 changelog

- [CHANGELOG_33.md](../changelog/CHANGELOG_33.md)：本次修复落地

## Agent 踩坑沉淀

无新候选（本次踩坑的 jsonl flush race + DB 时机 + zombie row 在已有约定「会话恢复 / 断连 UX（resume 优先）」 + 「资源清理 & TOCTOU 防线」节范围内，未来同类设计直接对照 CLAUDE.md 即可避免）。

```review-scope
src/main/adapters/claude-code/sdk-bridge.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/types.ts
src/main/adapters/aider/index.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/generic-pty/index.ts
src/main/ipc.ts
src/shared/types.ts
src/renderer/components/PendingTab.tsx
src/renderer/components/SessionDetail.tsx
src/renderer/components/pending-rows/index.tsx
```
