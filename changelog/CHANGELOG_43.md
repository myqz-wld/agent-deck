# CHANGELOG_43: SDK Task Manager 接入运行时 — sdk-bridge 挂载 + closure team_name + 实时事件

## 概要

[CHANGELOG_42](CHANGELOG_42.md) 完成 task manager 地基（5 个 in-process MCP 工具 + tasks 表 + per-task team_name 字段），但**没接入运行时**：应用内 SDK 会话调不到 `task_*` 工具。本次补 3 个缺口让 team 间任务派发能真正跑起来：

1. **缺口 1 — 挂到 sdk-bridge**：`query({ options })` 加 `mcpServers: { tasks: ... }` + `allowedTools: ['mcp__tasks__*']`，受新设置项 `enableTaskManager` 控制（默认 OFF，与 `injectAgentDeckPlugin` / `agentTeamsEnabled` 同模式）
2. **缺口 2 — Closure 自动注入 team_name**：每个 SDK 会话的 task tool handler 闭包当前 `session.team_name`，agent 不必（也不能）瞎传——`task_create / task_update / task_delete` 写锁在自己 team，`task_list / task_get` 只读允许跨 team 协调
3. **缺口 3 — 实时事件推送（Layer A+B）**：写操作 emit `task-changed` → main eventBus → IPC `IpcEvent.TaskChanged` 推 renderer。当前 renderer 没 task UI 消费（不做 Layer C），但基础设施有了，未来加 Tasks tab 直接 `onTaskChanged` 订阅即可

## 设计要点

### Per-session server instance（不是单例）

[CHANGELOG_42](CHANGELOG_42.md) 的 `getTaskMcpServer()` 全局单例改为 `getTasksMcpServerForSession(teamName)` 每次构造新 instance：
- 不同 session 闭包的 teamName 不同，server 不能共享
- 避免 cross-session state pollution（SDK 文档没明示 in-process MCP server instance 能否跨 session 复用，pending tool calls / RPC state 都是 instance 内部状态）

### 写权限锁矩阵

| 工具 | team_name 来源 | 行为 |
|---|---|---|
| `task_create` | 强制 closure（args 不暴露 team_name） | 写锁在自己 team |
| `task_update` | 强制 closure（args 不暴露） + 先 `repo.get` 校验 `target.teamName === closure`，不匹配返回 isError | 写锁；防跨 team 改 |
| `task_delete` | 强制 closure（同 update 校验） | 写锁；防跨 team 删 |
| `task_list`   | args 优先 / 不传时 = closure team；显式传 null = 全局 | 只读，允许 lead 跨 team 协调 |
| `task_get`    | 不限 team（只 task_id） | 只读，跨 team visibility 是协调必需 |

测试覆盖了 closure 注入、跨 team 写权限拒绝（含全局 vs team-A、team-A vs team-B 两种 mismatch）、closure=null 的「全局会话只能改全局任务」等边界。

### emit 不在 repo 而在 tools

`store/` 下所有 repo 都是 pure SQL（grep 验证：summary-repo / event-repo / session-repo 都不调 event-bus）。task-repo 也保持 pure；`task-changed` 事件 emit 放在 [tools.ts](../src/main/task-manager/tools.ts) 的 handler 里（write 操作 + emit 串在同一 handler，失败路径不 emit、保持 emit 与实际数据一致）。这样 task-repo 单测仍可独立跑（不依赖 event-bus mock）。

### 设置开关默认 OFF

与 `injectAgentDeckPlugin` / `agentTeamsEnabled` 同模式：spawn-time 注入；关掉**只影响下次新建会话**。已在跑的会话 mcpServers 列表已固化在 CLI 子进程，撤不掉（与 sandbox 同语义）。summarizer 走自己的 `query()` 不读本开关，天然隔离。

## 变更内容

### 共享层

#### `src/shared/types.ts`
- 加 `TaskChangedEvent`（紧跟 `TaskRecord` 后面）：`{ kind, taskId, task, teamName, ts }`
- `AppSettings.enableTaskManager: boolean`（带详细 doc 注释，说明 closure 自动注入语义）
- `DEFAULT_SETTINGS.enableTaskManager: false`

#### `src/shared/ipc-channels.ts`
- `IpcEvent.TaskChanged: 'event:task-changed'`

### Main 层

#### `src/main/event-bus.ts`
- `EventMap['task-changed']: [TaskChangedEvent]`

#### `src/main/index.ts`
- 加一行桥接：`eventBus.on('task-changed', (p) => safeSend(IpcEvent.TaskChanged, p))`

#### `src/main/task-manager/server.ts`（重写）
- 删 `getTaskMcpServer()` 单例 + `_resetTaskMcpServerForTest`
- 改 `getTasksMcpServerForSession(teamName: string | null): Promise<McpSdkServerConfigWithInstance>` —— per-session 一份独立 instance

#### `src/main/task-manager/tools.ts`（重写大部分）
- `buildTaskTools(repo: TaskRepo, teamName: string | null)` —— 第二个参数闭包注入
- 5 个 tool 的 schema 调整：`task_create / task_update / task_delete` 移除 `team_name` 字段；`task_list` 保留（args 优先 / 不传 = closure / null = 全局）；`task_get` 不变
- handler 内 try/catch + `eventBus.emit('task-changed', ...)` 写完后；权限锁（task.teamName !== closure → isError + 不调 repo）
- description 字符串里点出 `(${teamLabel})` 让 Claude 看到自己所属 team

#### `src/main/adapters/claude-code/sdk-bridge.ts`（小改）
- import `getTasksMcpServerForSession`
- 在 `query()` 调用前 `await getTasksMcpServerForSession(opts.teamName ?? null)`（仅当 `enableTaskManager === true`）
- query options 加 `...(tasksServer ? { mcpServers: { tasks: tasksServer }, allowedTools: ['mcp__tasks__*'] } : {})`
- 加一行 `console.log` 让运维能看到 mcpServers 是否挂上 + 哪个 team
- **不动其他 fail-recovery / fork 兜底逻辑**

### Preload 层

#### `src/preload/index.ts`
- import `TaskChangedEvent`
- 暴露 `onTaskChanged(cb): () => void`（仿 `onSummaryAdded` / `onTeamDataChanged` 模板）

### Renderer 层

#### `src/renderer/components/SettingsDialog.tsx`
- 在「实验功能」section 的 Agent Teams toggle 与沙盒下拉之间加 `enableTaskManager` toggle + 详细说明（与 Agent Teams 联动 / 与 markdown 任务并行 / 仅下次新建会话生效 amber 提示）

### 测试

#### 新增 `src/main/task-manager/__tests__/tools.test.ts`
- 24 cases，纯 mock（不依赖 SQLite，**任何 Node 版本都能跑**）
- mock `loadSdk` 让 fake `tool()` 返回透明对象（含 annotations 字段）
- mock `eventBus` 用 spy 监测 emit
- mock `TaskRepo` 用 vi.fn() 替全部方法
- 覆盖：5 个工具形状（schema 是否暴露 team_name）/ closure 注入 / emit kind & payload / 写权限锁 5 种场景（同 team 通过、跨 team 拒绝、全局 vs team / closure=null 仅全局通过）/ readOnlyHint annotation / repo 抛错时 isError 不 emit / list 各种过滤路径

#### `src/main/store/__tests__/task-repo.test.ts`
- 不动；CHANGELOG_42 的 23 cases 仍然 pass on Node 20.18

### 文档

- README「设置」节加一段说明 SDK Task Manager（与 Agent Teams / 沙盒同 section）
- 新增 `changelog/CHANGELOG_43.md` + 同步 `changelog/INDEX.md`

## 验证

```bash
# typecheck
zsh -i -l -c "pnpm typecheck"   # ✅

# tools.test 24 cases on system Node
zsh -i -l -c "pnpm test src/main/task-manager/__tests__/tools.test.ts"   # ✅ 24/24

# task-repo smoke 23 cases on Node 20.18
zsh -i -l -c "nvm use 20.18.3 && pnpm exec vitest run src/main/store/__tests__/task-repo.test.ts"   # ✅ 23/23

# build（main bundle 216→232 kB，+16 kB 给 sdk-bridge 集成 + closure 工厂）
zsh -i -l -c "pnpm build"   # ✅
```

实测路径（手动跑）：
1. 设置面板打开「SDK Task Manager」toggle
2. 新建带 `teamName='X'` 的 SDK 会话
3. 让 Claude: "call task_create with subject='测试任务', priority=8"
4. 验证：tasks 表新增一条 `team_name='X'` 的记录；renderer console 收到 `event:task-changed`（`window.api.onTaskChanged(console.log)` 加一句 ad-hoc 即可看到）
5. 让 Claude: "call task_list" → 应只返回 team='X' 的任务
6. 让 Claude: "call task_list with team_name=null" → 只返回全局任务
7. 让 Claude: "call task_update with task_id='<别的 team 的 id>', status='completed'" → 应被 isError 拒绝（permission denied）

## 不做的事 / 仍然 follow-up

- ❌ task UI（Layer C）— 加一个 TeamDetail 内的 Tasks tab 是另一个工程
- ❌ 主动给 teammate「推消息说有新任务」（lead.sendMessage 包装）—— 用户已选择不做
- ❌ 循环依赖检测 / proper-lockfile / 与 markdown 任务列表互通 — spec §5/§7 known limitations 不变
- ❌ 不在 sdk-bridge 改其他逻辑（仅在 query options 加挂载点；不动 recoverAndSend / fork 兜底等核心路径）

## 关联

- 上游：[CHANGELOG_42](CHANGELOG_42.md) task manager 地基
- 上游 team 机制：[CHANGELOG_35](CHANGELOG_35.md)（M1 sessions.team_name + UI）/ [CHANGELOG_39](CHANGELOG_39.md)（M2 fs 只读视图）/ [CHANGELOG_40](CHANGELOG_40.md)（M3 hook event）
- spec：`~/sdk-task-manager-spec.md`（不收仓）
