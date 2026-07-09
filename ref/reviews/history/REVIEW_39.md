---
review_id: REVIEW_39
title: hand_off_session 不传 team_name 但 UI 渲染 ↳ teammate badge bug R1+R1.5+R2 异构对抗 × 方案 1 fix（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh）
created_at: 2026-05-15
plan_id: hand-off-mcp-teammate-bug-20260515
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/hand-off-mcp-teammate-bug-20260515
base_commit: 91c4568
heterogeneous_dual_completed: true
---

# REVIEW_39 — hand_off_session UI ↳ teammate badge bug 排查 + 方案 1 fix

## 触发场景

用户实测报「『hand off mcp』还是会挂成 teammate」(2026-05-15 R37 archive_plan 收口后 hand-off 准备阶段),后追加补充「**没有 team 标志,但是在实时会话页面上有层级关系**」 — caller 与新 session 在实时会话面板呈 lead/teammate 视觉关系。

## 方法

按 user CLAUDE.md §决策对抗 多轮深度 review 编排:`deep-code-review` SKILL teammate 模式 + 反驳轮 + 三态裁决,与 REVIEW_36 / REVIEW_37 同款。

### 异构对抗 reviewer

| 轮次 | reviewer-claude | reviewer-codex | team |
|---|---|---|---|
| **R1** | 1 teammate(全 scope,sid `5d3daf68`)| 1 teammate(wrapper 跑外部 codex CLI,sid `b2dd7362`)| `hand-off-mcp-teammate-r1` |
| **R1.5 反驳轮** | 同 R1 sid 复用(跨轮 mental model)| 同 R1 sid 复用 | 同 team |
| **R2 fix audit** | 同 R1 sid 复用 | 同 R1 sid 复用 | 同 team |

### Scope

- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts` 全文
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session-impl.ts` 全文
- `src/main/agent-deck-mcp/tools/handlers/spawn.ts` 全文
- `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts` 全文
- `src/main/store/session-repo/spawn-chain.ts` 全文
- `src/renderer/components/SessionList.tsx` 全文
- `src/renderer/components/SessionCard.tsx` 全文
- `src/renderer/lib/session-selectors.ts` 全文
- `changelog/CHANGELOG_77.md`(SessionList Phase C 树形分组设计)
- `changelog/CHANGELOG_97.md`(hand_off_session baton 语义改造)
- `changelog/CHANGELOG_99.md`(双模式改造 + cwd resilience)
- `src/main/session/manager.ts:337-341 unarchiveOnUserSend`(R1 单方独有 finding 引出的相关代码)

### 工具

- mcp_agent-deck spawn_session / send_message(reply_to_message_id 链对话链)/ list_sessions / get_session
- worktree 内 Read / Grep 直接验证代码事实
- typecheck + tools.test.ts / spawn-guards.test.ts vitest

## 三态裁决清单

### ✅ HIGH-1 bug 主 finding(双方独立提出 ✅,实测验证)

**问题描述**:`hand_off_session` 不传 team_name 时新 session 仍在 UI 上显示 `↳ teammate` badge,与 baton 单向交接语义冲突。

**实测 evidence(lead Step 1.1 复现)**:
- 3 个用 hand_off_session 起的 active session 全部 `teams=[]`(都不挂 team) — 本会话 `5a15c51b` / worktree-stale-base 接力 `958a9c09` / codex-claude-symmetry 接力 `008c3906`(它的 team membership 是后来自己 spawn reviewer 时挂的,joinedAt 时间差 1 秒可证,不是 hand_off 当时挂的)
- 三者 spawnedBy=`024289d4`(R37 caller,仍 lifecycle=active)

**代码 trace**:

`spawn.ts:262`(修前):
```ts
if (callerExists) {
  const newDepth = opts?.batonMode ? parentDepth : parentDepth + 1;
  sessionRepo.setSpawnLink(sid, caller.callerSessionId, newDepth);
}
```

`SessionList.tsx:23-32` Phase C(CHANGELOG_77)按 spawnedBy 树形分组:
```tsx
if (s.spawnedBy && visibleIds.has(s.spawnedBy)) {
  const arr = childrenByOwner.get(s.spawnedBy) ?? [];
  arr.push(s);
  childrenByOwner.set(s.spawnedBy, arr);
}
```

`SessionCard.tsx:127-134` 渲染 `↳ teammate` badge,**完全基于 spawnedBy parent-child 关系,不查 team_member 表**。

**根因合成**:hand_off_session 调 spawn 透传 `{ batonMode: true, batonRole: 'lead' }` 但 setSpawnLink 仍写入新 session.spawnedBy=callerSid → SessionList 按 spawnedBy 树形分组渲染新 session 为 caller 的 teammate。

**严重度**:HIGH — 影响所有 plan 接力 hand-off 流程的可靠性 / 用户认知误导。

### ✅ HIGH-2 时间窗 race(claude R1 单方独有 + codex R1.5 反驳轮认同结论 + 修正机制)

**claude R1 原推理**:setSpawnLink 同步写 + broadcast,archive 异步 await 期间 caller archivedAt 仍 null → 必然时间窗 race。**这条独立于 archive 失败 / archive 时间窗 / unarchive 子集 case** — 即使 archive 100% 成功也触发。

**codex R1.5 反驳轮修正机制**:`spawn-chain.ts:30 setSpawnLink` 是 DB UPDATE **没有 broadcast**。真实窗口来自 spawn 后续 child upsert(典型 `spawn.ts:292 recordCreatedPermissionMode → manager.ts:358 emit session-upserted`)早于 `runBatonCleanup` archive caller 完成。结论一致 — race 真实存在。

**验证手段**:Read spawn-chain.ts:30 + spawn.ts:292 + manager.ts:358 + baton-cleanup.ts:155-211 链路。

**严重度**:HIGH — 是修法设计的关键依据(让 fix 不能依赖 archive 成功 / 时间假设)。

### ✅ HIGH-3 R37 caller 仍 active 是独立 root cause(双方独立提出,与本 bug 正交)

**双方观察**:R37 caller `024289d4` 实测 `lifecycle=active`,但按 archive_plan 默认行为应自动 archive(R37 plan 用 archive_plan tool 收口的)。可能场景:
1. **场景 A**:archive 实际失败但 `console.warn` 被吞(`baton-cleanup.ts:204-209` archive 失败 warn-only 不阻塞 ok return)
2. **场景 B**:R37 archive_plan 在 CHANGELOG_99 / CHANGELOG_109 baton-cleanup 改造**之前**完成 — 老版本 archive_plan 不自动归档 caller(CHANGELOG_99 才加)
3. **场景 C(codex 单方独有)**:`manager.ts:337-341 unarchiveOnUserSend` 用户从 UI 续聊已归档 caller 会被自动 unarchive 拉回 live(jsdoc 明示**仅 IPC AdapterSendMessage 触发,mcp tool send_message 不触发**)

**与本 bug fix 关系**:**正交独立**。本 plan 修方案 1 后,即使 caller 仍 active,新 session 不挂 spawnedBy → SessionList 不渲染 teammate badge,bug 修。但 caller archive 失败被 warn-only 吞掉是独立 UX 问题,影响所有 archive 场景(不仅 hand-off)。

**Follow-up 决策(用户拍板)**:本 plan 收口后**单独建 plan**追踪 archive UX 上抛 issue。

**严重度**:HIGH 但与本 fix 正交 → follow-up plan。

### ✅ MED-1 generic 模式(无 plan_id)同样受影响(双方独立 ✅)

`hand-off-session-impl.ts:169-186` generic 模式分支 + `hand-off-session.ts:321` 同款 spawn 调用走 `{ batonMode: true, batonRole: 'lead' }` opts → spawn handler 写 setSpawnLink 路径(`spawn.ts:260` `if (callerExists)`)与 plan 模式完全对称。**方案 1 fix 一并覆盖两种模式**。

### ✅ MED-2 普通 spawn(reviewer 派活)by design vs hand_off baton bug 的区分依据(双方独立 ✅)

| 路径 | 设计意图 | UX 期望 |
|---|---|---|
| `spawn_session(team_name=X)` lead 派活 | lead 持续活,reviewer 短期跑完反馈 | 树形 lead → reviewer 显示血缘 ✅ |
| `hand_off_session` baton 单向交接 | caller 即将 archive,新 session 独立接手 | **不应**树形挂(无后续关系)❌ |

区分依据是 `opts.batonMode` — 普通 spawn 缺省 false → 行为不变(继续写 spawn-link by design);hand_off_session 路径 batonMode=true → 跳 setSpawnLink。

### 方案选择反驳轮(R1 双方互相推对方方案 → R1.5 互换立场)

| | 方案 1 | 方案 5 |
|---|---|---|
| 实施 | spawn.ts:260-263 加 `!opts?.batonMode` 跳 setSpawnLink(~3 行 + 1 test) | SessionList + LineageSection 加 `child.spawnDepth > parent.spawnDepth` 判定(~12-15 行 + 2-3 test) |
| 时间窗 race 根治 | ✓ 数据层不写 spawn-link | ✓ spawnDepth 与 spawnedBy 原子写 |
| audit / list_sessions(spawned_by_filter) | 丢 baton child(grep 7 处 spawned_by_filter 全 reviewer 派活路径无 production 消费方)| 保留 |
| 与 baton 单向交接语义对齐 | ✓ baton ≠ spawn,数据层不应记录 parent-child | △ 用 spawnDepth 编码 type(ad-hoc encoding)|
| 哲学 | 简洁 / 实用主义 | 数据语义完整 |

**R1 状态**:claude 推方案 1 / codex 推方案 5 → 互相反对。

**R1.5 反驳轮结果**:
- reviewer-claude 改投方案 5(被 codex 「保留 spawn-link 数据真实性」隐含论据说服;自查推翻 codex「方案 1 丢救火」 — grep 7 处 spawned_by_filter 全是 reviewer 派活路径不是 baton)
- reviewer-codex 改投方案 1(被 claude grep 验证「baton child 无 production 消费方」说服;同时精修 claude HIGH-2 时间窗 race 机制描述)

**双方在反驳轮里互换立场后仍不可调和**(简洁优先 vs 数据语义完整)。

**用户决策(2026-05-15)**:**走方案 1 + 后续立 plan 跟 archive UX**。

**lead 倾向(供决策参考)**:推方案 1。理由:
1. `hand-off-session.ts:21-39` jsdoc 设计意图明文「baton 是 caller 单向交出 + 新 session 独立接手,**不是**派出小弟干活」 → baton 不是 spawn parent-child 关系,数据层不应记录假关系
2. 方案 5 是用 spawnDepth 编码 type 的 ad-hoc encoding(若未来真需要 baton chain audit,应引入显式 `spawn_link_kind: 'spawn' | 'baton'` 枚举字段或独立 baton-link 表)
3. codex 反驳轮自查 grep 验证 baton child 无 production 消费方 → 方案 1 副作用为零
4. 实施量小 5 倍

## R2 fix audit 结果

双方 audit fix diff 后 ✅ 通过:

| reviewer | 裁决 | finding |
|---|---|---|
| reviewer-claude R2 | fix 通过 ✅(无 HIGH/MED) | INFO-1 建议补 test 守门「batonMode=true + 显式 team_name」组合 |
| reviewer-codex R2 | fix 通过 ✅(无 HIGH/MED) | LOW-1 与 claude INFO-1 同款建议(双方独立 ✅) + INFO-4 hand-off-session.ts:306 stale 注释「setSpawnLink 写 lateral parentDepth」与新行为冲突 |

**双方独立 ✅ LOW/INFO** → 顺手补:
- LOW-1 / INFO-1: 给现有 R37 R2 HIGH-1 test (`tools.test.ts:881-901`) 加 1 行 `expect(setSpawnLinkCalls.find).toBeUndefined()` 守门「batonMode=true + 显式 team_name」组合
- INFO-4: hand-off-session.ts:306 注释更新明确指向新行为(spawn handler 现在 batonMode=true 路径完全跳 setSpawnLink)

## 修复条目

### HIGH(本 plan 内 fix)

1. **spawn.ts:260-263** 加 `&& !opts?.batonMode` 跳分流;ok return spawnDepth fallback 同步
2. **tools.test.ts** 加 2 守门 test case(batonMode=true 跳 setSpawnLink + spawnDepth=0 / batonMode 缺省守门普通 spawn 路径不变)+ 1 行 R37 R2 HIGH-1 test 内 `setSpawnLinkCalls toBeUndefined` 断言守门「batonMode=true + 显式 team_name」组合

### LOW / INFO(顺手补)

3. **hand-off-session.ts:306** stale 注释清理

### HIGH(follow-up,与本 fix 正交,单独建 plan)

4. **archive caller 失败 UX 上抛**:`baton-cleanup.ts:204-209` archive 失败 console.warn 被吞,但 ok return.archived='failed' 字段透传给 caller 没消费方。后续 plan 跟进 archive 失败应弹通知 / UI 显示而非仅 warn。

## 关联 changelog

[CHANGELOG_112.md](../../changelogs/history/CHANGELOG_112.md)
