# CHANGELOG_90: N bug fix — 用户「续聊」归档会话自动 unarchive（用户报告新 bug）

**plan**: mcp-bug-and-feature-batch-20260513 Phase 1.5（H2 新增 phase，临时插入处理 critical UX bug）

## 概要

用户反馈：「历史里归档的会话，继续聊不会自动转实时/非归档了，还是会躺在历史会话里归档状态」。

**根因**：`ipc/adapters.ts:215 AdapterSendMessage` IPC handler 直接调 `adapter.sendMessage(sid, text, attachments)` 不检查 `archivedAt`。归档会话被用户「续聊」（从 SessionDetail 历史里发新 message）后，archived_at 一直保持，UI 仍显示在历史归档面板。

**与既有正交约定的边界**：`manager.ts:152-156` 注释明确「归档与 lifecycle 正交，**不能因为后续事件流就自动 unarchive**，否则用户刚归档的 active 会话下一秒收到 hook 事件就被默默放回实时面板」。本 bug 修法严格区分两条路径：

- **用户主动 sendMessage / resume**（IPC AdapterSendMessage 桥点）= 显式信号 → **应该** 自动 unarchive
- **被动事件流到达**（hook event ingest 走 `ensure()`）= **不应** unarchive，保持正交约定

1 atomic commit，typecheck 双端通过 + 全 vitest 23 文件 347 it 通过（base 344 + 3 新 unarchiveOnUserSend test）。

## 变更内容

### A. `src/main/session/manager.ts` — 新公开 API `unarchiveOnUserSend(sid)`

加 method（在 `unarchive()` 之后），封装 guard 逻辑 + 复用 `unarchive()` 已有 archive_at = null + emit + team unarchive 联动行为：

```ts
async unarchiveOnUserSend(sessionId: string): Promise<void> {
  const r = sessionRepo.get(sessionId);
  if (!r || r.archivedAt === null) return;
  await this.unarchive(sessionId);
}
```

行为约定 jsdoc：
- 已 archived（archivedAt 非 null）→ 调 `unarchive()`（清 archived_at + emit upsert + team unarchive 联动）
- 未 archived → noop（不 emit / 不跑 team coordinator 多余工作）
- 不存在的 sid → noop（caller 自己处理 not-found）
- lifecycle 不动（与 `unarchive()` 同款约定）：dormant 仍 dormant、active 仍 active、closed 也保持
- **唯一调用入口**：IPC AdapterSendMessage handler。mcp tool send_message 走 universal-message-watcher 不经此 API（cross-session 程序化通信不算「用户主动续聊归档会话」UX 信号）

### B. `src/main/ipc/adapters.ts` — IPC handler 调 `unarchiveOnUserSend(sid)` 一行

`AdapterSendMessage` handler 在 `try { await adapter.sendMessage(...) }` 前加 4 行：

```ts
const sidParsed = parseStringId('sessionId', sessionId);
await sessionManager.unarchiveOnUserSend(sidParsed);
try { await adapter.sendMessage(sidParsed, text, attachments); ...
```

注释明确 N bug 修法 + 与「事件流被动到达」路径的边界（`manager.ts:152-156` 正交约定）。

### C. `src/main/session/__tests__/manager-public-api.test.ts` — 新增 3 it 验证

- **dormant + archived → 清 archivedAt + lifecycle 仍 dormant + emit upsert**：覆盖最常见的「历史归档」状态（dormant 是历史会话默认 lifecycle，与 archived 共存常见）
- **未 archived → noop**：guard 早返不该 emit / 不该跑 team-coordinator 多余 unarchiveTeamsForRevivedLead
- **不存在的 sid → noop**：caller 自己处理 not-found，本 method 不抛

## 不变量

- 「归档与 lifecycle 正交」约定不变：unarchive() 依然不动 lifecycle
- 「事件流被动到达 → archived 不动」约定不变：ensure() line 152-156 复活逻辑不变（被动 hook event 仍不触发 unarchive）
- mcp tool send_message 走 universal-message-watcher 不经 IPC AdapterSendMessage，不会被 unarchiveOnUserSend 影响（cross-session 程序化通信非「用户主动续聊」UX 信号）

## 验证

- `pnpm typecheck` 双端通过
- `pnpm exec vitest run src/main/session/__tests__/manager-public-api.test.ts` — **7 it 全过**（base 4 + 3 新）
- `pnpm exec vitest run` — **23 文件 347 it 全过**（2 文件 NODE_MODULE_VERSION binding 已知 skipped）
- dev smoke 验证（用户行为）：
  1. 应用打开归档会话 → SessionDetail 顶部输入框发新 message
  2. 期望：归档徽章立即消失 / 会话自动从历史归档面板移到实时面板（active/dormant 对应位置）
  3. 反向验证：被动事件流（hook event）到达归档 active 会话不应触发 unarchive（CLAUDE.md 正交约定）

## 与原 plan §设计决策的关系

原 plan §决策只覆盖 J/B（mcp 端）+ 各 phase 后续 follow-up，**不**包含归档 UX 修复。本 bug 是用户在 H1 完成后新报告的 critical bug，按 user CLAUDE.md「决策对抗」节判定属「单点判定 + 修法明确」（用户已 explicit 要修 + 修法路径单一），**不再走对抗**直接修。

修法决策 jsdoc 已写入 `manager.ts unarchiveOnUserSend()` + `ipc/adapters.ts AdapterSendMessage` 两处，方便未来追溯。

## H2 backlog 推进状态

- ✅ J bug + B check_reply（CHANGELOG_87 / Phase 1）
- ✅ C MED-D7 / E LOW / G MED-A7 / H HIGH-B2（CHANGELOG_88 / Phase 2）
- ✅ I `#sdkOwned` 真私有（CHANGELOG_89 / Phase 3）
- ✅ N bug：归档会话续聊自动 unarchive（本 CHANGELOG_90 / Phase 1.5 新增）
- ⏳ K1 archive_plan mcp tool — Phase 4a 续（impl.ts 已写 ~330 LOC，待 handler 入口 + 注册 + 单测）
- ⏳ K2 / K3 / Phase 5 同 plan
