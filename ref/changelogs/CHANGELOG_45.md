# CHANGELOG_45: Inbox Watcher — teammate 权限审批通路（Part A）+ Part D 待 spike

## 概要

Agent Teams 实验特性的 in-process backend 在 teammate 调 Bash / Edit 等需审批工具时，**不会**回到 lead 的 SDK `canUseTool` 回调（那个是绑在 lead Query 实例上的）。CLI 内部协议改为把 `permission_request` JSON 文本塞进 lead 的 inbox 文件 `~/.claude/teams/<team>/inboxes/team-lead.json`，等待 lead 写 `permission_response` 文本回 teammate 的 inbox。

实证：`/Users/apple/.claude/teams/dcr-tm-44/inboxes/team-lead.json` 真有两条 `{"type":"permission_request",...}` 文本消息，`read:true` 但永不被回应——deep-code-review skill 跑 reviewer-codex teammate 时一调 Bash 就死等批复。lead Claude 自己看不懂这种结构化消息，应用之前也没监听 inbox。

本次实施 Plan A：应用层加 inbox watcher，识别出 teammate 提的 `permission_request` 后走应用 PendingTab 同款 UI（approve / deny 按钮），用户响应时写 `permission_response` 文本回 teammate inbox 文件（与 SDK CLI 同 proper-lockfile 协议）。teammate 收到响应后继续跑。

**Part D（teammate 看不到 `mcp__tasks__*`）暂未实施**：方案需要把 in-process MCP 改成 stdio MCP server + 写 `<cwd>/.claude/.mcp.json` 让 teammate CLI 自动加载。但「in-process teammate 是否真从 `.mcp.json` 加载 MCP 服务」是 SDK 实验特性内部行为，文档无明文，需手工 spike 一次（写一份 `.mcp.json` 跑 lead + teammate 看 `/list_mcp_servers` 是否都能见到）才能投资正式实施。本 PR 不做。

## 设计要点

### Inbox 协议封装：与 SDK CLI 二进制完全对齐（实证）

[inbox-protocol.ts](../src/main/teams/inbox-protocol.ts) 把所有协议常量集中：
- 路径：`<homedir>/.claude/teams/<teamSlug>/inboxes/<memberSlug>.json`，slug 用 `name.replace(/[^a-zA-Z0-9_-]/g, '-')`（与 CLI `eEH(H)` 函数同款，`.` 也会被替换为 `-`）
- 锁：`<filepath>.lock`，proper-lockfile，`{retries:10, minTimeout:5, maxTimeout:100, realpath:false}`（与 CLI `O9_` 常量同款）
- `permission_response` schema：success = `{type, request_id, subtype:"success", response:{updated_input, permission_updates}}`；error = `{type, request_id, subtype:"error", error}`（与 CLI `Fe6(H)` 函数对齐）
- `permission_request` / `mode_set_request` schema 同理

**为什么必须用 proper-lockfile**：CLI 内部用同款 lock，两边并发读写不锁会丢消息或 corrupt JSON。lock options 任何参数不一致都可能 hold 时间错位踩到 race。

### Watcher 引用计数 + 60s grace（仿 [team-watcher.ts](../src/main/teams/team-watcher.ts) 模板）

[inbox-watcher.ts](../src/main/teams/inbox-watcher.ts) 监听 `<teamDir>/inboxes/` 整个目录（chokidar `awaitWriteFinish: 250ms`）；当前实现只关注 `team-lead.json`（lead inbox），其他成员 inbox 应用不代为审批。

**关键去重**：维护进程内 `Set<requestId>` —— chokidar 每次 file change 都重读全文件，没有去重就会反复弹给用户。响应后调 `markResponded(teamName, requestId)` 把 id 加进集合，下次 file change（如 lead 端读消息修改 read 标记）就不会重新 emit。文件 unlink → 清空集合（用户手动清理后允许重新弹）。

### 自动订阅：基于 active session.team_name

[main/index.ts](../src/main/index.ts) bootstrap 末尾 + `session-upserted` / `session-removed` / `session-renamed` 三个事件回调里都跑 `refreshAutoSubscribe()`：扫 `sessionRepo.listActiveAndDormant()` 收集所有非空 `team_name`，diff `wantTeams` vs `autoSubscribedTeams`，多了 subscribe / 少了 unsubscribe。用户根本不必打开 TeamDetail，inbox 自动监听。

UI 端 `TeamDetail` 也可以补强 subscribe（`window.api.subscribeTeamInbox`），grace 期内重用同 watcher，不浪费资源。

### 事件流复用：走 IpcEvent.AgentEvent + waiting-for-user kind

[translate.ts](../src/main/adapters/claude-code/translate.ts) 新增 `translateTeamPermissionRequest` —— 把 `TeamPermissionRequest` payload 包成 `AgentEvent { kind: 'waiting-for-user', sessionId: <leadSessionId> }`。bootstrap 在 `team-permission-requested` 事件回调里查 `sessionRepo.findByTeamName` 找 lead session（`source='sdk' + lifecycle='active'` 优先），调 `sessionManager.ingest`。

session-store 的 `pushEvent` 加新 `isTeamPermissionRequest` 探测器，把 payload 进新 Map `pendingTeamPermissionsBySession`。这样：
- PendingTab / SessionDetail 都能复用同款渲染基础设施（pending-rows）
- 与现有 `pendingPermissions` / `pendingAskQuestions` / `pendingExitPlanModes` 三张 Map 平级，不污染原有逻辑

### Renderer：TeamPermissionRow + PendingTab 第四类 section

[pending-rows/index.tsx](../src/renderer/components/pending-rows/index.tsx) 加 `TeamPermissionRow` 组件，仿 PermissionRow 模板：approve / deny 按钮 + 头部 chip 显示 `fromAgentId @ teamName`，便于一眼区分「这是 teammate 的请求」。响应时调 `window.api.respondTeamPermission(teamName, fromMemberSlug, requestId, decision, updatedInput?)`。

PendingTab + selectPendingBuckets 都加上 `teamPermissions` 字段，渲染时插在 PermissionRow / AskRow / ExitPlanRow 之后。chip 计数也对齐 4 类总和。

### 跨 renderer 同步：TeamPermissionResolved 事件

main 端写完 inbox response 后 emit `team-permission-resolved`（含 `teamName, requestId`），桥接到 IPC `TeamPermissionResolved`。App.tsx 新加 listener 调 `store.resolveTeamPermissionByTeam(teamName, requestId)` 把所有 sessionId 下匹配的条目都删掉（同一 requestId 全局唯一）。多窗口 / 外部清理场景都能同步。

## 变更内容

### 共享层

#### `src/shared/types.ts`
- 加 `TeamPermissionRequest` interface + `TeamPermissionDecision` 类型别名

#### `src/shared/ipc-channels.ts`
- 加 `IpcInvoke.TeamSubscribeInbox / TeamUnsubscribeInbox / TeamRespondPermission / TeamListPendingPermissions`
- 加 `IpcEvent.TeamPermissionRequested / TeamPermissionResolved`

### 持久化 / 协议层

#### `src/main/teams/inbox-protocol.ts`（新增）
- `slugifyMemberName(name)`：与 CLI `eEH(H)` 同款 `[^a-zA-Z0-9_-]→'-'`
- `getInboxesRoot()` / `getInboxPath(teamName, memberName)`：路径推导
- `parseSubMessage(text)`：识别 `permission_request / permission_response / mode_set_request`
- `appendInboxMessage(teamName, recipient, sub, opts)`：proper-lockfile 锁 + atomic write
- `buildPermissionResponse(requestId, decision, opts)`：构造 success / error response

#### `src/main/teams/inbox-watcher.ts`（新增）
- `inboxWatcher.subscribe(name) / .unsubscribe(name) / .markResponded(name, requestId)`
- chokidar 监听 `<teamDir>/inboxes/`，`ignoreInitial:false` 确保启动时已存在的 request 也能被识别（HMR / 重启场景下 store 是空的，watcher 重启会 replay 所有未响应 inbox 项）
- 60s grace + 引用计数（仿 team-watcher.ts）

### Main 进程

#### `src/main/event-bus.ts`
- `EventMap` 加 `'team-permission-requested': [TeamPermissionRequest]` + `'team-permission-resolved': [{teamName, requestId}]`

#### `src/main/index.ts`
- 桥接 `team-permission-requested` → `IpcEvent.TeamPermissionRequested` + 同时 `sessionManager.ingest(translateTeamPermissionRequest(...))` 走 AgentEvent 通路
- 桥接 `team-permission-resolved` → `IpcEvent.TeamPermissionResolved`
- `refreshAutoSubscribe()` 自动订阅活跃 team 的 inbox（bootstrap 末尾 + 三个 session 事件回调）
- before-quit cleanup 加 `inboxWatcher.shutdownAll()`

#### `src/main/ipc.ts`
- `TeamSubscribeInbox / TeamUnsubscribeInbox` handler（同 TeamSubscribe 模板）
- `TeamRespondPermission` handler：校验入参 → `appendInboxMessage` → `inboxWatcher.markResponded` → emit `team-permission-resolved`
- `TeamListPendingPermissions` handler（仅返回已响应 id，未来可扩展）

#### `src/main/adapters/claude-code/translate.ts`
- 新增 `translateTeamPermissionRequest(req, leadSessionId)` —— 包成 AgentEvent waiting-for-user

### Preload 层

#### `src/preload/index.ts`
- 暴露 `subscribeTeamInbox(name, cb)` / `respondTeamPermission(...)` / `onTeamPermissionResolved(cb)`

### Renderer 层

#### `src/renderer/stores/session-store.ts`
- 加 `pendingTeamPermissionsBySession: Map<string, TeamPermissionRequest[]>`
- `pushEvent` 加 `isTeamPermissionRequest` 探测器分支
- `removeSession / setSessions / renameSession` 同步处理新 Map（保持「写有清无」对齐）
- 加 `resolveTeamPermission(sessionId, requestId) / resolveTeamPermissionByTeam(teamName, requestId)`

#### `src/renderer/lib/session-selectors.ts`
- `PendingBucket.teamPermissions` 字段 + `selectPendingBuckets` 多接受一个 `pendingTeamPerms` 参数

#### `src/renderer/components/pending-rows/index.tsx`
- 新组件 `TeamPermissionRow`（仿 PermissionRow 形态，approve / deny 按钮 + fromAgentId / teamName chip）

#### `src/renderer/components/PendingTab.tsx`
- 接 `pendingTeamPermissionsBySession` + `resolveTeamPermission` 入参
- `PendingSection` 渲染 4 类列表

#### `src/renderer/App.tsx`
- pending 计数 useMemo 加第 4 类
- 新 useEffect 监听 `onTeamPermissionResolved` 调 `resolveTeamPermissionByTeam`

### 测试

#### `src/main/teams/__tests__/inbox-protocol.test.ts`（新增）
- 28 cases：slug 化（含 `.` 也被替换的边界）/ 路径拼装 / parseSubMessage 三类 schema + 损坏 input / buildPermissionResponse allow & deny / appendInboxMessage 原子写 + 多条追加保序 + 透传 fromAgentId / readInboxFile 容错坏 JSON / 顶层非数组 / 缺字段元素过滤 / 损坏文件后仍能继续追加

### 依赖

- 加 `proper-lockfile@^4.1.2` + `@types/proper-lockfile@^4.1.4`

## 不做的事 / Follow-up

### Part D（teammate 可见 task MCP）—— 仍待 spike + 实施

[CHANGELOG_43](CHANGELOG_43.md) 把 `tasks` MCP server 挂到 lead 的 `query({ options.mcpServers })`，**绑在 SDK Query 实例上**。in-process teammate 在不同 AsyncLocalStorage 上下文里跑（CLI `isInProcessTeammate: () => bW`），看不到 lead Query 的 sdkMcpTransports → 不能调 `mcp__tasks__*`。

方案 D（plan 已批）需要：
1. 把 in-process MCP 包成独立 stdio MCP server 子进程（`out/main/task-manager-stdio.cjs` + 通过 `ELECTRON_RUN_AS_NODE=1` 跑）
2. 拆 [tools.ts](../src/main/task-manager/tools.ts) 业务逻辑到 `business.ts`
3. 加 HTTP routes `/api/tasks/*` 到 hook-server，stdio server 通过 HTTP + Bearer token 调主进程 SQLite（避开跨进程 native binding 兼容问题）
4. 写 `<cwd>/.claude/.mcp.json` 注册 tasks server，env 注入 `AGENT_DECK_HOOK_PORT / TOKEN / TASKS_TEAM`
5. 删除 sdk-bridge 现有 in-process MCP 挂载（或加 `useStdioTaskManager` flag 双轨）

**关键不确定点**（plan 已点出）：in-process teammate 是否真的会从 `.mcp.json` 加载 tasks server？SDK 内部 `runWithTeammateContext` AsyncLocalStorage 切换上下文后是否重新走 settingSources 加载流程，无文档可查。

**建议先 5 分钟手工 spike** 再投资实施：
1. 装好本 PR (Part A) 后跑一个 SDK 会话，cwd 选任意工程
2. 在该 cwd 手写 `.claude/.mcp.json` 加一个 echo MCP server（或现有 tasks）
3. lead 跑 `/list_mcp_servers` 看到不到 `tasks`
4. 让 lead spawn 一个 teammate（`/agent-deck:deep-code-review` 或自然语言），teammate 跑 `/list_mcp_servers`
5. 都看到 = D 可行；只 lead 看到 = D 方案需重新设计（可能要走 `--mcp-config` 强制 + 让 teammate 继承）

### 其他不做

- ❌ TeamDetail 内置「teammate 待审批」面板（PendingTab 已涵盖；future polish）
- ❌ 替 lead 自动发 `mode_set_request` 给 teammate（让 teammate 一开始就 bypass，跳过整个 inbox 审批轮）—— 跟 Part D 拼一起做更合理（届时 teammate 既有 task tools 又不再需要 inbox 审批）
- ❌ inbox 历史完整 replay（当前只 in-memory 缓存 requestId，HMR 后 chokidar `ignoreInitial:false` 自动 replay 未响应项；已响应的会重新冒一次到 UI——是双 emit bug，但代价低，先观察）

## 验证

```bash
zsh -i -l -c "pnpm typecheck"   # ✅
zsh -i -l -c "pnpm test src/main/teams/__tests__/inbox-protocol.test.ts"   # ✅ 28/28
zsh -i -l -c "pnpm build"       # ✅ main 245.68 kB
```

实测路径（手动跑，要重启 dev）：

1. 设置面板开 `agentTeamsEnabled`（必需）+ 任意 permission mode（推荐 default 看到对照）
2. 新建带 `teamName='dcr-test'` 的 SDK 会话，prompt 触发 `/agent-deck:deep-code-review` skill
3. 等 lead spawn 两个 teammate，teammate 跑到第一次 Bash → **PendingTab 应出现「⚠ Teammate 等待审批」section**，显示 `reviewer-codex @ dcr-test` 的 Bash 命令
4. 点「允许」→ 应用写 `permission_response` success 到 `~/.claude/teams/dcr-test/inboxes/reviewer-codex.json`，teammate 继续跑（从原来卡住的 Bash 自然推进）
5. inbox 文件人工 `cat` 确认末尾追加了一条 `{type:"permission_response",subtype:"success",...}` 消息

## 关联

- 上游 team 机制：[CHANGELOG_35](CHANGELOG_35.md)（M1 sessions.team_name + UI）/ [CHANGELOG_39](CHANGELOG_39.md)（M2 fs 视图）/ [CHANGELOG_40](CHANGELOG_40.md)（M3 hook event）
- 上游 task manager（Part D 后续会基于此重构）：[CHANGELOG_42](CHANGELOG_42.md) / [CHANGELOG_43](CHANGELOG_43.md)
- 上游 deep-code-review skill（被本 PR 解锁的核心使用场景）：[CHANGELOG_44](CHANGELOG_44.md)
- plan 文件：`/Users/apple/.claude/plans/indexed-leaping-gizmo.md`

## 后续追加（同一 PR）

### deep-code-review skill 状态目录从项目根 → 用户级 + stale team 校验

**触发**：用户实测 Part A 后反馈「`.deep-code-review/` 文件不要放在项目根，检查到旧的任务了」。两件事一起改：

1. **状态目录迁移**：`<cwd>/.deep-code-review/` → `~/.claude/state/deep-code-review/<cwd-slug>/`，slug = `pwd | sed 's|[^a-zA-Z0-9_-]|-|g'`（与 Claude Code 自身 `~/.claude/projects/` 同款）
   - 不污染项目目录（之前每个 review 过的 repo 根都会留一个 `.deep-code-review/`）
   - per-cwd 隔离仍保留（不同项目的 state 互不干扰）
2. **续接前必跑 stale team 校验**：之前版本只看 `state.json.teammate_alive` 字段会被 stale 文件骗到（teammate 早被 cleanup / force-cleanup，state 还说 alive）。改为续接前必查 `~/.claude/teams/<team_name>/config.json` 是否存在 + `teammate_spawn_at` 距今 < 24h，任一不满足就 archive 旧 state（写 `state-archived-<ISO>.json`）+ 全新一轮
3. **收口必做归档 state**：Step 6 cleanup teammate 后把 `state.json` 改名 `state-completed-<ISO>.json`，避免下次启动被 stale 续接

涉及文件：
- `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`：Step 0 / Step 1 / Step 2 / Step 6 的 `.deep-code-review/` 路径全替成 `$STATE_DIR/`，Step 0 加「续接判断」三步流程，Step 6 加 mv 归档命令，「上下文 / 状态文件」节重写
- `.gitignore`：保留 `.deep-code-review/` entry（防御性 — 万一 skill regression / 用户手工建临时目录不被误 commit），加注释说明已迁移
- `<repo>/.deep-code-review/`：物理删掉（用户报项的旧残留）

**实测验证**：
```bash
# 旧目录确认不在
ls -la .deep-code-review/  # → No such file or directory ✅

# 新目录会在下次 skill 触发时自动建
ls ~/.claude/state/deep-code-review/  # 当前可能为空，跑一次 review 后会出现 cwd-slug 子目录
```

### sdk-bridge 显式传 `--team-name` + skill 校验 team 一致性

**触发**：用户实测后反馈「skill 创建的 team 和我在创建会话时选择的 team 不一样」。证据：state.json 里 `team_name: "deep-review-4d9f40b"` 是 lead Claude 自己 hash 出来的，**不是**用户在 NewSessionDialog 选的那个。

**根因双根**：

1. **应用层只注入 env 不传 team 名**：[sdk-bridge.ts:622-628](../src/main/adapters/claude-code/sdk-bridge.ts#L622-L628) 之前只注入 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env 当开关，**没把** `opts.teamName` 通过 CLI flag 传给子进程。CLI 看不到 team 名 → lead Claude 第一次 spawn teammate 时自己造一个名字。
2. **skill 默认让 lead 自创 team_name**：SKILL.md 状态字段表只列了 `team_name` 字段名，没要求 lead「team_name 必须从环境读，不要自创」→ lead 看到 prompt 自然 hash 一个。

**修法**（双端各修一处）：

**应用层（`src/main/adapters/claude-code/sdk-bridge.ts`）**：在 query options 加 `extraArgs: { 'team-name': opts.teamName.trim() }`（SDK Options 原生支持透传任意 CLI flag，CLI binary `--team-name <name>` arg 已实证存在 strings 出 `--team-name <name>`）。仅在「`agentTeamsEnabled` 开 + teamName 非空」时传，与现有 env 注入分支同条件。

**Skill 层（`SKILL.md` Step 0）**：

- 加新段「team_name 从环境取，不要自创」：教 lead 用 `~/.claude/teams/<X>/config.json` 找 `leadSessionId == 当前 SDK session_id` 的那项推断真实 team 名
- 「续接判断」节由 3 步扩成 4 步，新加 step 3：state.json.team_name 必须等于当前 lead session 所属 team；不等说明 state 是另一个 team 的旧文件 → archive + fresh
- 明确兜底纪律：应用层没传 `--team-name` → 跟应用方追这个传参缺失，**不要自创 team 名兜底**（那样三处会飘：应用层 sessions.team_name DB 列、CLI fs `~/.claude/teams/`、skill state.json）

**清理**：把现有 stale `state.json`（含错的 `team_name: "deep-review-4d9f40b"`）archive 成 `state-archived-pre-fix-<ts>.json`，避免下次启动用旧 team_name 续接。

涉及文件：
- `src/main/adapters/claude-code/sdk-bridge.ts`：query options 加 `extraArgs` 字段
- `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`：Step 0 加「team_name 从环境取」段 + 续接判断升 4 步
- `~/.claude/state/deep-code-review/-Users-apple-Repository-personal-agent-deck/state.json`：archive 成 `state-archived-pre-fix-*.json`

**验证**：
```bash
zsh -i -l -c "pnpm typecheck && pnpm build"   # ✅
```

实测路径（重启 dev 后跑）：
1. 新建带 teamName='X' 的 SDK 会话
2. **不**触发 skill，直接看 `ls ~/.claude/teams/` → 应只有 `X/`，并且 `cat ~/.claude/teams/X/config.json | jq .leadSessionId` 等于该会话 sdk session_id
3. 触发 skill `/agent-deck:deep-code-review` → spawn teammate 后再看：`X/config.json` 的 members 应有 reviewer-claude / reviewer-codex 两条，**不是**新建一个 `deep-review-<hash>/`
4. `cat ~/.claude/state/deep-code-review/-Users-apple-Repository-personal-agent-deck/state.json | jq .team_name` 应等于 `"X"`，不是自创名字

### 撤回 extraArgs `--team-name` + 仅保留 systemPrompt 注入

**实测错判修正**：上节加的 `extraArgs: { 'team-name': opts.teamName }` 想通过 SDK 把 CLI flag `--team-name X` 透给 lead CLI。**实测 CLI top-level help 没有 `--team-name` arg**（`zsh -i -l -c "$CLI --help"` 验证），strings 里看到的 `--team-name <name>` 字符串属于 CLI 内部模块文档（可能 subcommand / 内部协议），不是顶层启动 flag。

后果：用户开了 `team-X-test` 会话立刻报 `⚠ SDK 流中断：Claude Code process exited with code 1`（CLI 看到不识别的 flag → exit 1 → SDK query 立刻收到 `getProcessExitError(1)`）。

**修法**：撤回 `extraArgs` 改动，保留 `systemPrompt.append` 注入「你目前在 Agent Teams 中作为 lead 运行，所属 team 名为 \`X\`」一行。让 lead 在 system prompt 里"看到"自己 team 名，spawn teammate 时自然用这个名字，**不传 CLI flag** 就不会触发 CLI exit 1。

涉及文件：
- `src/main/adapters/claude-code/sdk-bridge.ts`：删 `extraArgs` 字段（保留 systemPrompt.append 注入）

**踩坑教训沉淀**（`.claude/conventions-tally.md` 候选）：「凭 strings 里有某 flag 字符串就当 CLI 顶层接受，没跑 `--help` 验证 → 误用 flag 让 CLI exit 1」。同主题再撞 2 次升约定（已有 P20「调研 SDK 行为机制凭直觉/局部观察 → 误判」与之同源）。

**验证**：
```bash
zsh -i -l -c "pnpm typecheck && pnpm build"   # ✅
```

实测：原报错 `Claude Code process exited with code 1` 应不再出现；新会话能起来；team_name 一致性靠 lead 读 system prompt 末尾那行实现（lead 不读 / 误读 → 退化到旧自创名字行为，但至少会话能起来）。

### CHANGELOG_46 预告（独立 PR）：team-coordinator 三层反向同步

system prompt 注入 team 名实测后用户报告：lead 把 `team-X-test` 自动 lowercase 成 `team-x-test`，prompt 兜不住。彻底放弃 prompt-engineering 路线，改纯工程方案：

- **反转设计前提**：fs 是 SSOT（lead 在会话内自由建 team），应用 DB `sessions.team_name` 跟随
- **新模块** `src/main/teams/team-coordinator.ts`：单一收口 `sync(sessionId, teamName, source)` 幂等反向同步 + chokidar root watcher 监听 `~/.claude/teams/*/config.json`
- **三层反向同步通道**（按时效）：
  1. **PreToolUse hook 拦 `TeamCreate / TeamDelete / Teammate / SendMessage` 工具**（决策瞬间，最早；CLI binary strings 实证 builtin 工具名）
  2. **fs add `~/.claude/teams/<X>/config.json`**（CLI 真写 fs ~几百 ms 后）
  3. **TaskCreated / TaskCompleted / TeammateIdle hook**（teammate idle / lead task 后，几分钟）
- **删 NewSessionDialog teamName 输入框** + IPC 入口预写（CLI `agent-deck new --team-name` 兼容保留）
- **task-mcp closure team_name 改 lazy 工厂** `() => sessionRepo.get(sid)?.teamName ?? null`（每次工具调用拿最新值）
- **放开 sdk-bridge resume + teamName throw**（应用不再 block，给上游 SDK limitation warn 让用户决定）
- **systemPrompt.append 注入 team 元信息撤回**（不再 prompt-engineering）

详见独立 CHANGELOG_46。
