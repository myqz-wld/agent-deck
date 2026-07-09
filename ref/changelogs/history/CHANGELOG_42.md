# CHANGELOG_42: SDK Task Manager — 5 个 in-process MCP 工具 + tasks 表 + team_name 适配

## 概要

Claude Agent SDK 没有原生任务管理工具（CLI 那侧最多有 TodoWrite，是 per-session 隔离的 todo 簿；不暴露结构化的 TaskCreate / TaskList 等给跨 SDK Agent 协作）。本次按 `~/sdk-task-manager-spec.md` 补一套自包含的 in-process MCP server：5 个工具（`task_create / task_list / task_get / task_update / task_delete`），存到 SQLite，让多个 SDK Agent / Lead-Teammate 可以读写同一份结构化任务表。

与 [CHANGELOG_35](./CHANGELOG_35.md) 引入的 `sessions.team_name` 标签机制对齐：tasks 表加可空 `team_name` 列（NULL = 全局任务，非 NULL = 该 team 范围共享），与 sessions.team_name **同语义** —— team 在 fs 被 Claude 删掉**不联动**删 task（保留为 orphan）。这样跟 `~/.claude/tasks/<team>/<list>.md` 那套 Claude 自然语言 markdown 任务列表**并行存在、互不覆盖**：markdown 是 Claude 内部用自然语言协作（[CHANGELOG_39](./CHANGELOG_39.md) M2 fs 只读视图已读），结构化 tasks 表是给 SDK 工具调用 + 应用结构化查询。

**本 PR 只做"地基"**：模块、表、工具、smoke test、build pass。还**不**改 [sdk-bridge.ts](../../src/main/adapters/claude-code/sdk-bridge.ts) 的 `query({ options })`，所以应用内 SDK 会话**当前调不到** `task_*` 工具——后续 follow-up（见末尾「不做的事」节）。

## 变更内容

### 持久化层

#### `src/main/store/migrations/v007_tasks.sql`（新增）

新建 `tasks` 表：
- `id TEXT PRIMARY KEY`（UUID v4，由 `crypto.randomUUID()` 生成）
- `team_name TEXT`（NULL = 全局；非 NULL = team 范围）
- `subject TEXT NOT NULL`（1-200 char，长度由 tool 层 zod 校验）
- `description TEXT`（≤2000 char，同上）
- `status TEXT NOT NULL DEFAULT 'pending'`（`pending|active|completed|blocked|abandoned` 五态）
- `active_form TEXT`（当前认领 agent 名，兼容 Claude Code TaskUpdate）
- `priority INTEGER NOT NULL DEFAULT 5`（0-10）
- `blocks TEXT NOT NULL DEFAULT '[]'` / `blocked_by TEXT NOT NULL DEFAULT '[]'`（JSON string of task id[]）
- `labels TEXT NOT NULL DEFAULT '[]'`（JSON string of string[]）
- `created_at` / `updated_at` ISO8601

索引：
- 部分索引 `idx_tasks_team_name ON tasks(team_name) WHERE team_name IS NOT NULL`（与 v006 sessions.team_name 同款节省策略）
- `idx_tasks_status` / `idx_tasks_updated_at DESC`（覆盖 list 默认排序 + 最常用过滤）

#### `src/main/store/migrations/index.ts`（修改）

注册 v007 进 MIGRATIONS 数组（v001-v007）。`initDb()` 检测 `user_version=6` → 自动跑 v007 → 升到 7。已有用户数据无影响（只新增表）。

#### `src/main/store/task-repo.ts`（新增）

完全对齐 [summary-repo.ts](../../src/main/store/summary-repo.ts) 风格的 per-table repo：
- `createTaskRepo(db: Database)` 工厂函数：测试可注入 in-memory db
- `taskRepo` 默认导出懒拿 `getDb()` 的单例方法
- 5 个方法：`create / get / list / update / delete`
- `update` 增量改：白名单字段（不让外部改 id / created_at），强制刷 updated_at；用 `Object.prototype.hasOwnProperty.call(patch, key)` 区分「显式传 null = 清空」vs「不传 = 不动」
- `list.teamName` 三态：`undefined` = 全部任务（含全局 + 所有 team）/ `null` = 仅全局（`team_name IS NULL`）/ `string` = 该 team
- `delete cascade`：BFS 收集下游 + Set 去重防自循环（spec §5 不检测循环依赖，但 cascade 内部仍要挡住死循环）→ `db.transaction()` 包住 DELETE + 反向引用清理
- `safeJsonArray` 防御 JSON 损坏：parse 失败或非 string[] → 退化空数组 + console.warn，不抛错（避免一条脏数据让整个 list 接口挂掉）

### SDK 工具层

#### `src/main/task-manager/tools.ts`（新增）

5 个 `tool()` 定义，全部走 `loadSdk()` 异步加载（[sdk-loader.ts](../../src/main/adapters/claude-code/sdk-loader.ts) 同款 `new Function('s', 'return import(s)')` 套路绕开 Vite 静态 ESM 转译陷阱）。Zod 4 直接顶层 import（peer dep ^4.0.0，CJS/ESM 双 mode 都支持）。

字段命名：tool args 用 snake_case（与 spec / Python SDK / Claude Code CLI TaskCreate 一致），repo / TaskRecord 内部用 camelCase（agent-deck TS 惯例），`argsToCreateInput` 在 handler 里手工映射。

错误策略：所有 handler 内 try/catch；store 抛错（如 subject 空）→ 返回 `isError: true`，不让 throw 中断 agent loop。`task_list` / `task_get` 加 `annotations: { readOnlyHint: true }` 让 Claude 可并行调。

#### `src/main/task-manager/server.ts`（新增）

`getTaskMcpServer()` 顶层入口：模块单例 + 懒构造（第一次调用才 loadSdk + 建 tools）。调用方契约（地基阶段还没接：sdk-bridge 后续 follow-up 在 `query({ options })` 里这样挂）：

```ts
const tasksServer = await getTaskMcpServer();
query({ options: {
  mcpServers: { tasks: tasksServer },
  allowedTools: [...existing, 'mcp__tasks__*'],
}});
```

### 共享类型

#### `src/shared/types.ts`（修改）

新增 `TaskStatus` enum + `TaskRecord` interface（与 SQL 表一一对应，camelCase + ISO8601 timestamp）。

### 测试

#### `src/main/store/__tests__/task-repo.test.ts`（新增）

23 个 vitest case，对齐 spec §6 验收 + 补充 team_name / cascade 自循环 / 损坏数据容错 / 100 条并发：

- 基本 CRUD 9 case（含 subject 空校验、null 清空、updated_at 单调递增、id 不存在返回 null）
- list 排序与过滤 6 case（含 teamName 三态、case-insensitive subject 模糊、多条件 AND）
- cascade delete 5 case（含**人工制造循环依赖**测试 cascade 不死循环）
- 并发与持久化 2 case（100 条并发 / 写文件 → close → 重新打开数据还在）
- 损坏数据容错 2 case（`vi.spyOn(console, 'warn')` 验证 warn 被调用 + 退化空数组）

**Binding 守门**：照搬 [search-predicate.test.ts:5](../../src/main/store/search-predicate.test.ts#L5) 的项目惯例 —— `better-sqlite3` 的 native binding 是 electron-builder install-app-deps 给 Electron Node 重编的（NODE_MODULE_VERSION 跟系统 Node 不同），vitest 走系统 Node 大概率加载失败。文件顶部 `probeBetterSqliteBinding()` 自检：失败一次 warn + 全部 describe `skipIf(!bindingAvailable)` 跳过。本机实测：`nvm use 20.18.3` + `pnpm exec vitest run src/main/store/__tests__/task-repo.test.ts` → 23/23 全过；`nvm use default`（Node 22/24）→ 23/23 全 skip。

### 依赖

- `pnpm add zod@^4.0.0`（SDK peer dep，本地之前未装）；main bundle 体积从 ~189 kB 涨到 216 kB（+27 kB）

## 不做的事 / Follow-up

本次只是地基，跑通 spec §6 验收 + build pass。**应用内 SDK 会话当前还调不到 task 工具**，需要后续做以下 3 件才真能跑起 team 间任务派发：

1. **挂到 sdk-bridge**：在 [sdk-bridge.ts](../../src/main/adapters/claude-code/sdk-bridge.ts) `query({ options })` 加 `mcpServers: { tasks: await getTaskMcpServer() }` + `allowedTools: ['mcp__tasks__*', ...]`。需要重启 dev。可考虑加设置项开关（与 `injectAgentDeckPlugin` 同模式，用户能关）。
2. **自动注入 current session.team_name**：当前 task tool 的 `team_name` arg 由 Claude 显式传，Claude 凭什么知道自己 session 的 team？两种路径：
   - 在 sdk-bridge 注入 task server 时把 current `session.team_name` 闭包进 tool handler，从 source-of-truth 自动填，args 不再暴露 team_name（更稳，防 Claude 忘传 / 传错）
   - 在 systemPrompt append 文本告诉 Claude「You belong to team X, pass team_name='X' when calling task tools」（更灵活，Claude 可手动跨 team）
3. **任务推送 / 通知**：teammate 不主动 `task_list` 就不知道有新任务派给它。spec §7 已标 known limitation。team 协作场景里通常通过 [team-watcher.ts](../../src/main/teams/team-watcher.ts) 的 chokidar 模式扩展（监听 tasks 表变更 → emit 应用事件 → renderer / 其他 SDK 会话捕获）。

本次也明确不做的：
- 不做循环依赖检测（spec §5 known limitation；cascade 内部用 Set 去重挡住死循环已够）
- 不引 proper-lockfile / Promise queue（SQLite WAL + 单 main 进程已搞定）
- 不同步 `~/.claude/tasks/<team>/<list>.md` 的 Claude 自然语言任务（两套并行）
- 不写权限 / 多用户 / audit log / IPC 暴露给 renderer（spec §7 扩展项；UI 集成是另外一档功夫）

## 关联

- 设计源：`~/sdk-task-manager-spec.md`（本仓库不收）
- 上游 team 机制：[CHANGELOG_35](./CHANGELOG_35.md)（M1 sessions.team_name + UI）/ [CHANGELOG_39](./CHANGELOG_39.md)（M2 fs 只读视图）/ [CHANGELOG_40](./CHANGELOG_40.md)（M3 hook event）
- Migration pattern 参考：[CHANGELOG_22](./CHANGELOG_22.md)（Phase 4 N4 单轨化 + Vite `?raw`）
