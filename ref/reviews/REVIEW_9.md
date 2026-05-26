---
review_id: 9
reviewed_at: 2026-04-28
expired: false
---

# REVIEW_9: ExitPlanMode 批准 bypass 红字 emit + cli 孤儿会话双根因对抗

## 触发场景

CHANGELOG_33 落地后用户报两条体感 bug：
1. plan 模式批准 ExitPlanMode 选「完全免询问（bypassPermissions）」会先弹一条红字「⚠ SDK 流中断：Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use」。明明是设计内的「主动 interrupt + 主动重启」，UI 体验像系统崩了。
2. 同场景下 SessionList 多出一条带 cli 标签的孤儿会话。

两条都是 approve-bypass 冷切路径的副产品。属于「给代码下定性判断 + 设计修法」范围，按 CLAUDE.md「决策对抗」节走双异构 Agent 对抗。

## 方法

**双对抗配对**（异构 SDK / 模型）：
- **Agent A**：Claude Code 内部 `general-purpose` subagent（Opus 4.7 xhigh）
- **Agent B**：外部 Codex CLI（gpt-5.5 xhigh，prompt 经登录式 zsh + sandbox=read-only + `-o` 抓最终答案）

**范围**：bypass 冷切路径（approve-bypass → restartWithPermissionMode → closeSession → createSession）+ hook 通道兜底（dedupOrClaim 三道防线 + recentlyDeleted 黑名单）

```text
[问题集 1] 红字 emit 根因 + D' 方案（expectedClose flag）
[问题集 2] cli 孤儿会话根因 + 修法（提前 expectSdkSession vs rename 加黑名单）
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
src/main/adapters/claude-code/sdk-bridge.ts
src/main/adapters/claude-code/hook-routes.ts
src/main/session/manager.ts
```

**约束**：每条结论 ✅/❌/⚠️ + 文件:行号 + 关键代码片段；不接受废话；总判断给最大风险点 + 必改设计。

## 三态裁决结果

### ✅ 真问题（双方独立提出 / 现场核实成立）

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| 1 | HIGH | sdk-bridge.ts:320-324 → 1438-1430 | 红字根因 a+b+c 链路：(a) approve-bypass resolver 返 `{deny, interrupt:true}` →(b) SDK 强制中止 ExitPlanMode tool_use turn 时收到 `result_type=user / stop_reason=tool_use` 不一致 result，内部抛 `[ede_diagnostic]` →(c) `consume()` catch 块无差别 emit「⚠ SDK 流中断」红字 | ✅ 完整链路一致 | ✅ 完整链路一致 |
| 2 | MED | manager.ts:411-421 + 1463 | cli 孤儿会话根因 = OLD_ID 的迟到 SessionEnd hook：close 后 OLD CLI 子进程 SIGTERM 异步飞的尾包，dedupOrClaim 三道防线全失效——sdkOwned 已 release（line 1463 / line 1103）+ sessionRepo.get(OLD_ID) 已不存在（rename 触发的 INSERT-NEW + DELETE-OLD）+ cwd 兜底已被一次性 consume（NEW createSession 的 line 481 releasePending）→ ensureRecord 用 `source: opts.source ?? 'cli'` 复活成新 cli source record | ⚠️ 简短点出 race | ✅ a/b/c 三道全失效路径精准定位 |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| Codex 方案 B | catch 块字符串匹配 `ede_diagnostic` | 违反 CLAUDE.md「不依赖 SDK 错误字符串匹配」P12 教训；SDK 升级换错误文案即失效 |
| Codex 方案 E | 改 allow + setPermissionMode 跳过 race | sdk-bridge.ts:1133-1136 已注明 `setPermissionMode('bypassPermissions')` 被 SDK 静默吞，bypass 真正开关只能 createSession 时锁；REVIEW_8 HIGH-1 race 也躲不开 |
| Codex 方案 1（cli 孤儿） | restartWithPermissionMode 入口提前 expectSdkSession(rec.cwd) | cwd 兜底是一次性 consume，OLD CLI 飞多条迟到 hook 时只能接住第一条；方案 1B（rename 加 recentlyDeleted 黑名单）覆盖更全且适用所有 rename 场景 |

### ⚠️ 部分（双方都看到但角度不同）

| 现场 | A 视角 | B 视角 | 结论 |
|---|---|---|---|
| expectedClose flag 打标位置 | 仅 closeSession 入口 | closeSession + approve-bypass resolver 双处 | A + B 互补：双处打标（双保险），覆盖所有应用主动关闭场景 |
| recentlyDeleted 是否需要清 OLD_ID | 60s ttl 自动过期，不需要 | rename 后 OLD_ID 永远不会再出现，60s 黑名单足够 | 一致：60s ttl 与 SessionManager.delete 用法对齐 |

## 修复（CHANGELOG_34 落地）

### HIGH
1. **sdk-bridge.ts: InternalSession + respondExitPlanMode + closeSession + consume catch** — D' 方案：`expectedClose` flag 双处打标（approve-bypass resolver 之前 + closeSession interrupt 之前），catch 块判 flag → console.warn 不 emit 红字。

### MED
2. **manager.ts: renameSdkSession** — 1B 方案：`sessionRepo.rename(fromId, toId)` 之后立即 `this.recentlyDeleted.set(fromId, Date.now())`，OLD_ID 60s 内迟到 hook event 在 ingest 入口被 `isRecentlyDeleted` 直接丢弃。

## 关联 changelog

- [CHANGELOG_34.md](../changelog/CHANGELOG_34.md)：本次修复落地

## Agent 踩坑沉淀

无新候选。两条根因都属于「会话恢复 / 断连 UX（resume 优先）」+ 「事件去重与生命周期」节既有约定的边界细化（race 时序 + rename 与 delete 的对称性），未来同类设计直接对照 CLAUDE.md 即可避免。
