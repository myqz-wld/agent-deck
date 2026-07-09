# spike1-spawn-from-ipc — IPC layer adapter.createSession 路径实证

> Plan: `issue-tracker-mcp-20260529` §Step 0.5 spike (a) / §D14 / §D14b
> Runner: `spike1-spawn-from-ipc.runner.mjs`
> Trace log: `spike1-spawn-from-ipc.log`
> Date: 2026-05-30
> Status: ✅ pass (6/6 checks)

## 动机

Plan §D14 选定 spawn 路径（b）：UI Issues tab「Resolve in new session」按钮调 IPC handler，**绕过 mcp tool 层 `spawn_session`**，直接走 adapter 层 API 起独立 SDK session。理由：

1. IPC handler 没有 SDK session caller_session_id 闭包（应用主进程发起），走 mcp tool 路径要伪造 caller closure
2. spawn-guards 三道防御（depth / fan-out / spawn-rate-limit）对 UI 触发的语义不适用（user 在 UI 端起独立 session ≠ agent spawn agent）
3. `spawn_session` mcp handler 内部最终也是调 `adapter.createSession(buildCreateSessionOptions(...))` — 绕过 mcp 层语义对齐

D14b 不变量：spawn entry SSOT = `adapter.createSession(buildCreateSessionOptions(...))`（`AgentAdapter` interface 方法）；`SessionManager` **不**暴露 `createSession`。

## 假设

| # | 假设 | 验证手段 |
|---|---|---|
| H1 | `adapterRegistry.get(id)` 在 IPC main process 可用（adapter init 时机不晚于 IPC handler 注册） | grep 现有 IPC handler 实证 |
| H2 | `adapter.createSession(buildCreateSessionOptions(...))` 路径已被生产 IPC handler 用 | grep `src/main/ipc/adapters.ts:105-182` AdapterCreateSession handler |
| H3 | IPC 路径不写 `spawn-link`（`sessions.spawned_by IS NULL`，`spawn_depth = 0`） | grep `setSpawnLink` 调用位置 + DDL 默认值 |
| H4 | `recordCreatedPermissionMode(sid, mode ?? undefined)` 持久化用户主动选的 permissionMode | grep IPC handler 实证 |
| H5 | `buildCreateSessionOptions(adapterId, raw)` narrow 到 ClaudeCreateOpts 而非 union | TS overload 实证 |

## 实测命令

```bash
# Worktree 根目录跑
SPIKE_REPO="$PWD" zsh -i -l -c 'node .claude/plans/issue-tracker-mcp-20260529/spike-reports/spike1-spawn-from-ipc.runner.mjs'
# 输出（同时落 spike1-spawn-from-ipc.log）：
# ✅ IPC handler 现有路径 (adapter.createSession 调用存在)
# ✅ IPC handler 现有路径 (buildCreateSessionOptions 调用存在)
# ✅ setSpawnLink 仅 mcp tool spawn handler 调
# ✅ spawn_depth DDL DEFAULT 0
# ✅ recordCreatedPermissionMode 持久化
# ✅ buildCreateSessionOptions narrow
# 6/6 checks pass
```

## 实测结果

### Check 1 + 2 — IPC handler 现有路径已用 adapter.createSession + buildCreateSessionOptions

`src/main/ipc/adapters.ts:105-182` AdapterCreateSession handler 完整跑这条路径多年（NewSessionDialog 每次起会话都跑）。关键代码：

```ts
on(IpcInvoke.AdapterCreateSession, async (_e, agentId, opts) => {
  const validAgentId = parseStringId('agentId', agentId, 64);
  const adapter = adapterRegistry.get(validAgentId);
  if (!adapter?.createSession) throw new Error('adapter cannot create session');
  // ... 字段校验 ...
  sid = await adapter.createSession(
    buildCreateSessionOptions(validAgentId, {
      cwd, prompt,
      ...(permissionMode !== null ? { permissionMode } : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(teamName !== null ? { teamName } : {}),
      // ...
    }),
  );
  sessionManager.recordCreatedPermissionMode(sid, permissionMode ?? undefined);
});
```

✅ H1 + H2 直接成立 — IPC handler 早就走通这条路径。

### Check 3 — setSpawnLink 仅 mcp tool spawn handler 调

```bash
$ grep -nE "setSpawnLink\(" src/main/ipc/adapters.ts
# 0 matches
```

`setSpawnLink` 调用点列表（grep 全仓）：

| 文件 | 路径性质 |
|---|---|
| `src/main/agent-deck-mcp/tools/handlers/spawn.ts` | mcp tool spawn handler — 唯一生产调用点 |
| `src/main/store/session-repo/spawn-chain.ts` | 实现本身 |
| `src/main/__tests__/_shared/mocks/session-repo.ts` | 测试 mock |
| `src/main/agent-deck-mcp/__tests__/*.test.ts` | mcp tool 测试 |

✅ H3 part-1：IPC handler 不调 setSpawnLink，自然不写 spawn_link。

### Check 4 — spawn_depth DDL DEFAULT 0

```sql
-- src/main/store/migrations/v009_mcp_spawn_chain.sql:21-22
ALTER TABLE sessions ADD COLUMN spawned_by TEXT REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0;
```

✅ H3 part-2：不调 setSpawnLink → `spawned_by` 保持 NULL（column 默认）+ `spawn_depth` 保持 0（DDL DEFAULT 0）。

### Check 5 — recordCreatedPermissionMode 持久化

`src/main/ipc/adapters.ts:182`:

```ts
sessionManager.recordCreatedPermissionMode(sid, permissionMode ?? undefined);
```

实现位于 `src/main/session/manager/lifecycle.ts:245` `recordCreatedPermissionModeImpl`。

✅ H4 成立 — IPC `IssuesResolveInNewSession` helper 直接复用同款调用即可，符合项目 CLAUDE.md §会话恢复 / 断连 UX「用户上次主动选过的 acceptEdits / plan / bypassPermissions 必须复原」硬约束。

### Check 6 — buildCreateSessionOptions typed overload narrow

`src/main/adapters/options-builder.ts:209-216`:

```ts
export function buildCreateSessionOptions<T extends AgentId>(
  agentId: T,
  raw: CreateSessionOptionsRaw,
): Extract<CreateSessionOptions, { agentId: T }>;
export function buildCreateSessionOptions(
  agentId: string,
  raw: CreateSessionOptionsRaw,
): CreateSessionOptions;
```

✅ H5 成立 — caller 传入 `'claude-code'` 字面量时走 typed overload，return type narrow 到 `ClaudeCreateOpts & { agentId: 'claude-code' }`，TS 编译期阻止 `codexSandbox` 等 codex 专属字段误传。

## 结论

✅ **plan §D14 选定路径 (b) 完全成立**：

1. IPC handler 走 `adapterRegistry.get(adapterId).createSession(buildCreateSessionOptions(adapterId, {cwd, prompt, ...}))` 是**生产已落地多年路径**，不是新设计 — 现有 NewSessionDialog 入口每次起会话都走它
2. 该路径**自动跳过** spawn-guards 三道防御 + **不写** spawn-link（spawn_depth 保留 DDL DEFAULT 0），符合 §D14 「UI 触发的 Resolve 不是 agent spawn agent」语义
3. `recordCreatedPermissionMode` 持久化保证 SDK session resume / recoverAndSend 时复原用户主动选的 permissionMode（项目 CLAUDE.md §会话恢复 硬约束）
4. `buildCreateSessionOptions` typed overload 给 IPC handler 编译期保护，避免误传跨 adapter 字段

**Step 3.5.1 实施时**：抽 `createIssueResolutionSession({adapter, cwd, prompt, permissionMode?, claudeCodeSandbox?, codexSandbox?})` helper 复用 `AdapterCreateSession` (`src/main/ipc/adapters.ts:105-182`) 的边界硬化代码（`parseStringId` / 显式 `if (!a || !a.createSession) throw` / `cwd` 长度校验 / `prompt` 长度校验 / 默认 sandbox / `recordCreatedPermissionMode`），不可 optional chain `?.createSession` 吞错。

## 残留风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 未真起 SDK session 验证 lifecycle 落 'active' / events emit / sessions row INSERT | 现有 IPC AdapterCreateSession 生产已验证多年 → 反推同款；Step 3.10.3 `pnpm dev` GUI 验证回归实证 |
| R2 | adapter.init 时机晚于 IPC handler 注册 → 第一个 IssuesResolveInNewSession 早 click 撞 init race | bootstrap 顺序由 `src/main/index/bootstrap-infra.ts` `initAdapters` 早于 `registerIpcHandlers` 保证，与现有 AdapterCreateSession 共享同款时序无新风险 |
| R3 | IPC handler 内 in-flight Promise dedupe Map 跨 IPC 多窗口实例化（多 BrowserWindow 拷贝 handler）— 实际单 handler 注册仅一份 in main process | Electron main process 单实例特性 + IPC handler 全局注册 → Map 单例 OK；测试覆盖 (Step 3.5.6 IPC test) 验证 |
| R4 | UI throttle button.disabled 与 IPC dedupe 双层保护漏一层时连点起多 SDK | Step 3.5.1 + Step 3.8.4 同步落地两层（D14 兜底要求） |

## 下一步

✅ Step 0.5 spike (a) PASS — 进 Step 3.1 DB schema migration v026_issues.sql。
