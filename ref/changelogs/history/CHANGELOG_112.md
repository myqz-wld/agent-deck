# CHANGELOG_112: hand_off_session 不写 baton spawn-link + UI ↳ teammate badge bug 方案 1 修

## 概要

用户实测 R37 archive_plan 收口后调 `mcp__agent-deck__hand_off_session` 起接力会话报「『hand off mcp』还是会挂成 teammate」+ 补充「**没有 team 标志,但是在实时会话页面上有层级关系**」(plan `hand-off-mcp-teammate-bug-20260515`)。异构对抗 R1+R1.5+R2(reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh teammate)定位 root cause = `spawn.ts:262 setSpawnLink` 在 batonMode=true 路径仍写 `new session.spawnedBy=callerSid`,SessionList Phase C(CHANGELOG_77)按 spawnedBy 树形分组渲染 `↳ teammate` badge,**与 team membership 完全无关**(团队名 / member 表无关)。R1.5 反驳轮双 reviewer **互换立场**(claude R1 推方案 1 → R1.5 改投方案 5 / codex R1 推方案 5 → R1.5 改投方案 1)后用户决策走方案 1。详 [REVIEW_39.md](../../reviews/history/REVIEW_39.md)。

## 变更内容

### 主 fix(`src/main/agent-deck-mcp/tools/handlers/spawn.ts`)

batonMode=true 路径**完全不写 spawn-link**(spawnedBy=null + spawnDepth=0 默认值):

```diff
-      if (callerExists) {
-        const newDepth = opts?.batonMode ? parentDepth : parentDepth + 1;
+      if (callerExists && !opts?.batonMode) {
+        const newDepth = parentDepth + 1;
         sessionRepo.setSpawnLink(sid, caller.callerSessionId, newDepth);
       }
```

ok return spawnDepth fallback 同步:
```diff
-      spawnDepth: created?.spawnDepth ?? (callerExists ? (opts?.batonMode ? parentDepth : parentDepth + 1) : 0),
+      spawnDepth: created?.spawnDepth ?? (callerExists && !opts?.batonMode ? parentDepth + 1 : 0),
```

新加 ~25 行注释说明:
- 修前 bug 描述(SessionList 树形分组 + 真实时间窗 race 来自 spawn 后续 child upsert 早于 archive caller)
- 修法理由(baton 是 caller 单向交出,不是 spawn parent-child;数据层不应记录假 spawn-link)
- 历史 CHANGELOG_98 batonMode lateral spawnDepth 设计意图被本 fix 推翻(原意是给 spawn-guards 跳 depth check,不是 UI 区分)
- 副作用范围(LineageSection / list_sessions(spawned_by_filter) / PendingTab / SessionDetail / TeamDetail / spawn-guards 都已逐一验证无影响)
- Follow-up 路径(若未来真需要 baton chain audit 应引入显式 `spawn_link_kind: 'spawn' | 'baton'` 枚举字段而非靠 spawnDepth 间接编码)

### 守门 test(`src/main/agent-deck-mcp/__tests__/tools.test.ts`)

加 2 新 test case + 1 行断言:

1. **batonMode=true → 不调 setSpawnLink + spawnDepth=0**:模拟 hand_off_session default 路径(不传 team_name + batonMode=true + batonRole=lead),断言 `setSpawnLinkCalls.find(c.id===newSid)` undefined + `parsed.data.spawnDepth === 0`
2. **batonMode 缺省 → 守门普通 spawn 路径不变**:断言 setSpawnLink 仍写 `{id, parentId:lead, depth:1}` + spawnDepth=1(reviewer 派活 by design 不变)
3. **R37 R2 HIGH-1 现有 test 内补 1 行**(R2 LOW-1/INFO-1 双方独立 ✅):「batonMode=true + 显式 team_name」组合下也跳 setSpawnLink,防未来 refactor 误把 team_name 加进短路条件让 escape hatch 退化回 bug

### 文档清理(`src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts`)

`hand-off-session.ts:306` 注释更新(R2 INFO-4 codex 单方 finding):明确说明 spawn handler 现在 batonMode=true 路径完全跳 setSpawnLink,历史 CHANGELOG_98「setSpawnLink 写 lateral parentDepth」语义已被本 fix 推翻;详细注释见 spawn.ts:257-284。

## 不修

### 与本 bug 正交的独立 root cause(单独建 plan 跟进)

R37 caller `024289d4` 实测 lifecycle=active(应被 R37 archive_plan 自动归档但未生效),双 reviewer 共识三类可能场景:
- 场景 A:`baton-cleanup.ts:204-209` archive 失败 warn-only 被 console.warn 吞掉
- 场景 B:R37 archive_plan 在 CHANGELOG_99 / CHANGELOG_109 baton-cleanup 改造之前完成
- 场景 C:`manager.ts:337-341 unarchiveOnUserSend` 用户从 UI 续聊已归档 caller 自动 unarchive 拉回 live(jsdoc 明示**仅 IPC AdapterSendMessage 触发,mcp tool send_message 不触发**)

**与本 bug fix 正交**:即使 caller 仍 active,本 fix 让新 session 不挂 spawnedBy → SessionList 不渲染 teammate badge,bug 修。但 caller archive 失败 warn-only 被吞是独立 UX 问题(影响所有 archive 场景不仅 hand-off)。**用户拍板单独建 plan** `archive-failure-ux-upthrow-20260515` 跟进。

### 普通 spawn 路径(reviewer 派活)by design 不变

`spawn_session(team_name=X)` lead 派活仍写 spawn-link → SessionList 树形分组显示 lead/teammate badge(by design,CHANGELOG_77 设计意图)。

### archive_plan 类似 baton 流程

archive_plan 不 spawn 新 session,**无对称 bug**(R1 双方共识)。

## 验证

- typecheck 双端 0 错
- `tools.test.ts` 46/46 通过(含本 plan 新加 2 case + R37 R2 HIGH-1 test 内补 1 行断言)
- `spawn-guards.test.ts` 12/12 通过(确认 spawn-guards depth check 用 callerSession.spawnDepth 不依赖新 session.spawnDepth → fix 让新 session.spawnDepth=0 对 depth check 零影响)

## 详 plan / review

- plan: [`plans/hand-off-mcp-teammate-bug-20260515.md`](../../plans/history/hand-off-mcp-teammate-bug-20260515.md)
- review: [REVIEW_39.md](../../reviews/history/REVIEW_39.md)
