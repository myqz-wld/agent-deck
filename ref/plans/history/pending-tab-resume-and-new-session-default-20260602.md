---
plan_id: pending-tab-resume-and-new-session-default-20260602
created_at: 2026-06-02
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/pending-tab-resume-and-new-session-default-20260602
status: completed
base_commit: 0d2bb1d
base_branch: main
final_commit: c9509c4
completed_at: 2026-06-02T20:00:00+08:00
---

# pending tab resume 可见性 + 新建会话选项记忆

> 用户 2026-06-02 报两个问题：(1) resume 后 pending tab 的请求在会话详情页看不到，pending tab 看得见；(2) issue 详情「起新会话解决」弹窗里权限模式 / 系统沙盒没记忆，每次重选。

## 总目标 & 不变量

1. **修复 BUG 1**：SDK 会话 resume 后，ActivityFeed「活动」tab 默认就能看到 in-process 的 AskUserQuestion / Permission / ExitPlan 请求（与 pending tab 同步可见）。**不**在详情页顶部加额外 banner（用户明确反对）。
2. **修复 BUG 2**：NewSessionDialog（顶部「＋」按钮起的）和 ResolveInNewSessionDialog（issue 详情起的）两个弹窗共享一组 last-used ref state，permissionMode / codexSandbox / claudeCodeSandbox 三个字段跨 mount / 跨 dialog 打开不丢失。重启 app 不持久化（用户明确要求"自动记住上次选的"，不要 settings 默认值）。

**不变量**：

- N1 SessionDetail 顶部**不加** in-process pending 渲染区（用户反对），保持「活动 / 改动 / 总结 / 跨会话 / 权限」5 个 tab 不动。
- N2 BUG 2 跨 mount 用 `useRef` 在组件外（模块顶层或 hook）保存 last-used，**不**写 `localStorage` / **不**走 AppSettings。
- N3 BUG 2 跨 adapter（claude-code / codex-cli）下，三字段不串味：claudeCodeSandbox 只在 claude-code 弹窗里记，codexSandbox 只在 codex-cli 弹窗里记（按 adapter 维度分 key）。
- N4 现有架构不动：ActivityFeed / PendingTab / SessionDetail / NewSessionDialog / ResolveInNewSessionDialog / settings-store 5 个组件契约不变。

## 设计决策

### D1 BUG 1 修根因 = ActivityFeed 重新拉 pending（RFC 第 2 轮 Q1「只修根因，详情页不额外加东西」）

**根因**：ActivityFeed useEffect deps = `[sessionId, agentId, isSdk, setRecent, setPending]`，resume 路径下 SessionDetail 不重 mount、ActivityFeed useEffect 不重跑，`listAdapterPending(agentId, sessionId)` 不会在 resume 时再同步一次。主进程 SDK 协议层 resume 后新 emit 的 in-process AskUserQuestion 落到 `pendingAskQuestionsBySession` Map（live pushEvent 走通了），但 ActivityFeed 的 `pendingAskQuestions` selector 读到的就是它——**row 应该有**。

**真因是**：`recent` 流（`recentEventsBySession`）只在 `setRecentEvents`（ActivityFeed mount 时调一次 `listEvents`）时刷新；resume 期间 live pushEvent 推入的 `waiting-for-user` 事件理论上应该同步进 recent（pushEvent:210-215 是同事务），但 **resume 期间 + App 重启时序 race**：

- App 重启 → onAgentEvent 订阅还没挂上 → 主进程在 await 期间把 waiting-for-user 推到 webContents.send → 推空
- App 重启 → listSessions await 期间到达的 event 走 onAgentEvent → 已挂上 → pushEvent 入 store.recentEvents ✓
- 但 **listAdapterPendingAll('claude-code')**（App.tsx:78-87 mount 时调一次）**只跑一次**，且**仅在 App mount**，不在 session 切换 / resume 时跑

修法：在 ActivityFeed useEffect 加 `selectedSessionId` / `isSdk` 之外，再加一个「resume 触发」信号 ——
**简化为**：每次 ActivityFeed mount 时**始终重跑** listAdapterPending 同步（即使 deps 不变）。React 默认 mount-only effect 跑一次，但用 ref 检测 sessionId 切换 + useEventBridge 已有 onSessionUpserted → 触发 forceRefresh。

**最小侵入修法**：

- 复用现有 `setPending` store action
- ActivityFeed useEffect 改成「sessionId 变时**额外**再调一次 listAdapterPending」（mount 第一次也调，已是现有行为；sessionId 切换时调，**也**是现有行为）
- **新增**：监听 `onSessionUpserted` 当同 sessionId 但内容「重新激活」（active lifecycle 切换）时，强制重拉 listAdapterPending

具体实现：ActivityFeed 增加一个 effect：

```ts
useEffect(() => {
  if (!isSdk) return;
  const off = window.api.onSessionUpserted((s) => {
    if (s.id !== sessionId) return;
    // session upserted 来了：可能 resume 完成 / lifecycle 转 active → 重拉 pending
    void window.api.listAdapterPending(agentId, sessionId).then((res) => {
      setPending(sessionId, res.permissions, res.askQuestions, res.exitPlanModes);
    });
  });
  return off;
}, [sessionId, agentId, isSdk, setPending]);
```

**为什么 this 修法对**：resume 路径（session-upserted + lifecycle 转 active）会触发 onSessionUpserted → 拉一次 listAdapterPending 同步。in-process 等待的 AskUserQuestion 入 store.pendingAskQuestionsBySession → ActivityFeed 顶部 row 出现。

`recent` 流的同步走的是 pushEvent live 通道，已有；如果 race window 极小导致 pushEvent 漏了，listEvents 兜底（DB 已存 event），但 **listEvents 不在 resume 触发**。

**配套加一条**：ActivityFeed useEffect deps 加上 `sessionId` 变化时的「重拉 listEvents」——**已存在**（deps 含 sessionId）。所以 mount 一次 + 切会话重跑是 OK 的。**不需要改**。

但有个 edge case：**ActivityFeed 已 mount（用户在实时面板看 live 视图）→ 用户点该会话进 detail → ActivityFeed 新 mount**（App.tsx 父子复用但 ActivityFeed 内部 sessionId prop 变化算 remount，详 React 行为）→ 触发 listAdapterPending 一次。

而「resume 路径下用户在实时面板看历史会话」实际是**用户先点历史会话进 detail → 后端 activate + upserted → renderer 收到 onSessionUpserted**。此时 ActivityFeed 已 mount，sessionId prop 已就位。**只有 onSessionUpserted 触发**能再拉一次 pending。

✅ 修法 D1 落地。

### D2 BUG 2 = 模块顶层 ref state（RFC 第 2 轮 Q2「两个弹窗都改，不持久化」）

**实现**：建 `src/renderer/hooks/useLastSessionDefaults.ts`，内部 `useRef`（实际是模块级 `let` 变量，跨 mount 持久）按 adapter 维度存三字段：

```ts
type Defaults = {
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  codexSandbox?: CodexSandboxChoice;
  claudeCodeSandbox?: ClaudeSandboxChoice;
};
const store: Record<'claude-code' | 'codex-cli', Defaults> = {
  'claude-code': {},
  'codex-cli': {},
};
export function getLastDefaults(adapter: string): Defaults { ... }
export function setLastDefaults(adapter: string, patch: Partial<Defaults>): void { ... }
```

- `getLastDefaults(adapter)` 读
- `setLastDefaults(adapter, patch)` 写（merge）

NewSessionDialog 改造：
- `useState` 初值从 `getLastDefaults(adapter)` 拉（按当前 agentId）
- `onChange` 调 `setLastDefaults(adapter, { field: value })`

ResolveInNewSessionDialog 同款。

**`onChange` 写时按当前 adapter 维度 key**（N3 不串味）。ResolveInNewSessionDialog 切换 adapter 时也重读。

**`agentId='claude-code'` 时写 claudeCodeSandbox、`agentId='codex-cli'` 时写 codexSandbox**，互不干扰。permissionMode 仅 claude-code 写（co capability gate 与现有保持一致）。

### D3 不动 settings-store（user 选择）

不引入 `newSessionDefault*` 字段，不改 SettingsDialog。范围最小。

## 步骤 checklist

- [ ] Step 1 — D1 实施：ActivityFeed 加 onSessionUpserted 监听 + 重拉 listAdapterPending（`src/renderer/components/activity-feed/index.tsx`）
- [ ] Step 2 — D2 实施：建 `src/renderer/hooks/useLastSessionDefaults.ts` 模块顶层 store + get/set
- [ ] Step 3 — D2 实施：NewSessionDialog 改造（`src/renderer/components/NewSessionDialog.tsx`），useState 初值读 ref、onChange 写 ref
- [ ] Step 4 — D2 实施：ResolveInNewSessionDialog 改造（`src/renderer/components/ResolveInNewSessionDialog.tsx`），同上
- [ ] Step 5 — `pnpm typecheck`
- [ ] Step 6 — 写 CHANGELOG_X.md + 同步 INDEX
- [ ] Step 7 — archive_plan 原子归档

## 当前进度

- ✅ 探索根因 + RFC 两轮（用户拍板）
- ✅ 进 worktree（HEAD = 0d2bb1d）
- ⏳ 写 plan（本文件刚写完）
- ⏳ 实施

## 下一会话第一步

按 plan §步骤 checklist 从 Step 1 开始实施。先 `Bash: cat .claude/plans/pending-tab-resume-and-new-session-default-20260602.md` 拿最新进度（用户可能已编辑），按 Step 1 改 `src/renderer/components/activity-feed/index.tsx`。

## 已知踩坑

- ActivityFeed memo 行内 `pendingPermIds`/`pendingAskIds`/`pendingExitIds` 走 useMemo 派生自 `pendingPermissions/Asks/Exits`（line 84-95），新加的 listAdapterPending 写 store 后这些 useMemo 会自动重算（依赖是数组引用变化）—— 不需要 ActivityRow 改 prop 接口
- BUG 2 跨 adapter key 分桶是 N3，模块顶层 `let` 存 `Record<adapter, Defaults>` 而不是 `Defaults` 一坨，prevent codex 选 sandbox=workspace-write 串到 claude 默认
- `useRef` 不能跨组件实例，**模块顶层 `let`** 才是真跨 mount
- AppSettings 类型不动（D3）

## 关联

- 无关联 plan / changelog（独立报修）
