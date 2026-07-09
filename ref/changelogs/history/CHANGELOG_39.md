# CHANGELOG_39: Agent Teams M2 — Team 视图（fs 监听 + Team Hub / Team Detail）

## 概要

CHANGELOG_35 的 M1 让用户能启动 team 会话，但应用层只看到 lead 一条 SDK session（in-process 模式 teammate 不暴露独立 session_id）—— team 内成员 / 共享 task list 完全黑盒。M2 把 Claude 自管的 `~/.claude/teams/<name>/config.json` 与 `~/.claude/tasks/<name>/<task-list>.md` 这两份 fs 数据可视化到应用里：新建 `view='teams'` 顶部 tab，`TeamHub` 列出所有团队（含 fs 与 SQL 两个数据源合并），点击进 `TeamDetail` 显示成员清单 + 应用内会话 + shared task list（markdown 渲染）+ chokidar 实时监听 fs 变化自动刷新。

## 变更内容

### 数据层 (`src/main/teams/`)

- `team-fs.ts`（新）：只读访问 `~/.claude/teams/<name>/` 与 `~/.claude/tasks/<name>/`
  - `getTeamsRoot()` / `getTasksRoot()` 暴露常量绝对路径
  - `validateTeamName()` 内部校验（同 IPC parseTeamName 规则：字母数字 . _ - / ≤ 64）
  - `ensureWithinRoot()` realpath + 前缀比对防 symlink 越权（与 image-load 同模式）
  - `listTeams(distinctSqlNames, sessionsByName)` 合并 fs 子目录 + SQL distinctTeamNames 两个数据源 → `TeamSummary[]`（按 name 字典序）
  - `readTeamConfig(name)` 容错解析：corrupt JSON / 文件缺失 / 权限拒绝 → 返回 null；schema 兼容（agentType / agent_type / sessionId / session_id 都接，原样保留未知字段）
  - `readTaskList(name)` 命名优先级匹配（`task-list.md` / `tasks.md` / `TODO.md`）+ 最大 mtime 兜底
  - `getTeamSnapshot(name, sessions)` 一次性拼 sessions + config + task list

- `team-watcher.ts`（新）：chokidar 引用计数订阅
  - `subscribe(name)` / `unsubscribe(name)` 引用计数 +1/-1
  - 引用计数到 0 后**等 60s grace** 才真 close（防快速切换 TeamDetail 反复 close/reopen，复用既有 watcher）
  - 监听 `[teamDir, tasksDir]` 两个目录的 `add` / `change` / `unlink` / `unlinkDir` → emit eventBus `'team-data-changed'` { name, kind: 'config' | 'task-list' | 'unlinked' }
  - chokidar 配置 `awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 }` 防写入中颤抖
  - `shutdownAll()` 立即 close 所有 watcher，main `before-quit` 调一次（chokidar 持有 fs handle 不 close 会让进程退不干净）

### 共享类型 (`src/shared/types.ts`)

新增 5 个类型（紧跟 `SessionRecord` 之后）：

- `TeamMember`：name + 可选 agentType / agentId / sessionId + `[key]: unknown` 兜底未知字段
- `TeamConfig`：members 数组 + mtime + 原始 raw JSON
- `TeamSnapshot`：完整 team 视图（sessions + config + taskListFile + taskListMarkdown + taskListMtime）
- `TeamSummary`：列表项简表（name + sessionCount + hasConfig + hasTasks + lastEventAt）
- `TeamDataChangedEvent`：fs 变化事件 payload（name + kind: 'config'|'task-list'|'unlinked'）

### IPC 通道 (`src/shared/ipc-channels.ts`)

- `IpcInvoke` 加 4 个：`TeamList` / `TeamGet` / `TeamSubscribe` / `TeamUnsubscribe`
- `IpcEvent` 加 1 个：`TeamDataChanged`

### 主进程 IPC + bootstrap (`src/main/ipc.ts` + `src/main/index.ts`)

- ipc.ts 加 4 个 handler，全部用 `parseTeamName` 校验 name；TeamList 内部读 `sessionRepo.distinctTeamNames()` + `findByTeamName()` 拼数据
- index.ts bootstrap 加 `eventBus.on('team-data-changed', (p) => safeSend(IpcEvent.TeamDataChanged, p))` 桥接到 renderer
- index.ts before-quit cleanup 加 `await teamWatcher.shutdownAll()`，置于 adapterRegistry.shutdownAll 之前（chokidar handle 不 close 会让 hookServer.stop 后进程仍卡住）

### Event Bus 类型 (`src/main/event-bus.ts`)

`EventMap` 加 `'team-data-changed': [TeamDataChangedEvent]`

### Preload (`src/preload/index.ts`)

加 4 个 api wrapper：

- `listTeams()` / `getTeam(name)` 直接 invoke
- `subscribeTeam(name, onChange)` 返回 unsubscribe 闭包：内部 attach `IpcEvent.TeamDataChanged` listener（按 payload.name 过滤，所有 team 共享同一 channel）+ 异步调 `TeamSubscribe` IPC；unsubscribe 同时 detach + 调 `TeamUnsubscribe`
- subscribe / unsubscribe 异步失败仅 console.warn 不阻塞 renderer

### Renderer (`src/renderer/`)

- `App.tsx`：`type View` 加 `'teams'`；header 加「团队」TabButton（点击同 PendingTab 模式 `select(null)` 避免 detailSession 盖掉视图）；main 区域加 `view === 'teams' ? <TeamHub /> : ...` 分支
- `components/TeamHub.tsx`（新）：列出所有 team，每条卡片显示 name + sessionCount + hasConfig/hasTasks chip + lastEventAt 相对时间；5s polling 兜底刷新；点击进 TeamDetail
- `components/TeamDetail.tsx`（新）：顶部 header（back 按钮 + name）+ 4 个 section：
  - 概要（成员数 / 会话数 / config 状态 / task list 状态 4 个 stat 卡）
  - 成员（来自 config.json，每条带 agentType chip + sessionId 截断显示）
  - 应用内会话（来自 DB，点击跳 SessionDetail；与 config members 交叉标「✓ 在 config」chip）
  - 共享 task list（顶部显示文件路径 ~ 化展示 + mtime；中间 markdown 渲染原文，无文件时给提示）
  - mount 时 subscribe（fs 任意变化触发 refresh），unmount 时 unsubscribe

### 依赖

`pnpm add chokidar@^3.6.0`（package.json 显式 dependencies；vite/electron 之前可能间接引入但不在依赖图里，显式加避免依赖隐式被 hoist 干掉）

> **chokidar 必须用 3.x，不能用 4.x / 5.x**：4.x 起改 ESM-only，electron-vite 把 main 打成 CJS bundle，运行时 `require('chokidar')` 会抛 `ERR_REQUIRE_ESM`。3.x 是 CJS + 仍维护 + API 跟 4/5 完全兼容（watch / awaitWriteFinish / on('add')），是这套技术栈唯一稳定选项。如果将来要升级到 4/5，得先把 main 改成 ESM 输出 + 全局所有 require 检查（成本远超收益）。team-watcher.ts 代码 100% 兼容 3.x，不用改。

## 已知限制 / 后续

- **in-process backend cleanup 上游 bug**：teammate `shutdown_approved` 后 config.members 不移除 → cleanup 永远拒绝；M2 仅在 TeamDetail 概要段显示提示「config 存在但 members 为空可能是 cleanup 残留，可手动 rm」，不加 force-cleanup 按钮（避免误删活 team —— 等 M3 接 TeammateIdle hook 拿到 ground truth 再加）
- **TeamHub polling 5s 兜底**：sessionCount / lastEventAt 可能延迟 5s 反映 session-* 事件；后续可换成 IPC `SessionUpserted` / `SessionRemoved` listener 触发 refresh，但当前简单 polling 够用
- **不显示 team 内事件流**：M2 范围只做 fs 视图；M3 接 hook event 后再补 TeamDetail 右栏「最近 team-* 事件」时间线
- **fs 路径硬编码 `~/.claude/`**：与 Claude Code 自身约定一致；如果 Claude 之后允许配置其他路径，team-fs.ts 需要跟随调整

## 验证

- `pnpm typecheck` 通过 ✅
- `pnpm build` 通过 ✅
- 手动验证（用户重启 dev 后）：
  1. 应用顶部 tab 出现「团队」按钮
  2. 没建过 team → TeamHub 显示「没有团队」+ 操作引导
  3. `mkdir -p ~/.claude/tasks/demo-team && echo "- [ ] task1" > ~/.claude/tasks/demo-team/task-list.md` → TeamHub 出现 demo-team 卡片，hasTasks ✓
  4. 点击进 TeamDetail → task list 段渲染 markdown
  5. 在另一终端 `echo "- [ ] task2" >> ~/.claude/tasks/demo-team/task-list.md` → renderer 250ms 内（chokidar awaitWriteFinish）刷新出新内容
  6. `rm -rf ~/.claude/tasks/demo-team` → renderer 收到 unlinked 事件，TeamHub 列表里该 team 消失（下次 polling 5s 内）
  7. 用 M1 入口建一个 teamName=demo-team 的 SDK 会话 → TeamDetail「应用内会话」段出现该 session
  8. 试 `name='../../etc'` 调 IPC → 主进程 throw IpcInputError，不读盘

## 后续修复（事后追加）

- **symlink 越权防护误报**（M3 verify 时暴露）：`ensureWithinRoot` 只 realpath target 不 realpath root → 用户 `~/.claude → ~/.claude-default` 这种 symlink 链下，target 真实路径前缀（`.claude-default/...`）跟 root 逻辑路径前缀（`.claude/...`）不匹配，所有合法读取都被误报「path escape」。修法：root 也走 realpath（失败兜底用原 root 处理「~/.claude/teams 首次运行还没建」边界）。team-watcher 用的 chokidar 自身就支持 symlink，无需改。这条是双 symlink（root + target 都 symlink）场景下 path 越权防护的标准做法
- **symlink 修复后又踩 target-不存在边界**（M3 force-cleanup verify 时暴露）：上一条修复让 root 也 realpath 后，**target 不存在**时（典型：force-cleanup 删完 fs → chokidar unlinkDir → renderer refresh → getTeam → readTeamConfig 重读已删文件）走 realpath 失败回退到 resolved 路径（`.claude/...`），但 root realpath 成功（`.claude-default/...`），两边形态又不一致 → 前缀对不上误报「path escape」让 UI 短暂闪红框。**根因是单边 realpath 单边 resolved 的形态不对称**。修法：target 与 root **必须用同一种形态**比对——target 存在用两边 realpath（解 symlink 防 TOCTOU），target 不存在用两边 resolve（不解 symlink，因为没文件可读真实越权风险消失，剩下的就是防字面量 `..` 越权 resolve 已规范化）。这是双 symlink + target-may-not-exist 场景下越权防护的完整解
